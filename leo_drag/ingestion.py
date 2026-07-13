"""Restartable ESA VirES HAPI ingestion into canonical one-minute Parquet.

Only collection identifiers registered in :mod:`leo_drag.schema` are allowed.
Raw API bytes and their metadata are retained separately from processed data.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

import numpy as np
import pandas as pd

from .manifest import (
    DEFAULT_MANIFEST_RELATIVE_PATH,
    append_manifest_error,
    load_manifest,
    upsert_manifest_entry,
    utc_now_iso,
)
from .schema import CANONICAL_DENSITY_COLUMNS, COLLECTIONS, collection_for, normalize_hapi_response

VIRES_HAPI_BASE_URL = "https://vires.services/hapi"
USER_AGENT = "heliosat-internal-leo-density-research/1.0"
DEFAULT_PARAMETERS = (
    "Timestamp", "Latitude_GD", "Longitude_GD", "Height_GD",
    "local_solar_time", "density", "density_orbitmean",
    "validity_flag", "validity_flag_orbitmean",
)


@dataclass(frozen=True)
class IngestionPaths:
    data_root: Path
    raw_root: Path
    processed_root: Path
    manifest_path: Path

    @classmethod
    def from_data_root(cls, root: str | Path) -> "IngestionPaths":
        data_root = Path(root).resolve()
        return cls(
            data_root=data_root,
            raw_root=data_root / "raw" / "thermosphere",
            processed_root=data_root / "processed" / "thermosphere",
            manifest_path=data_root / DEFAULT_MANIFEST_RELATIVE_PATH,
        )


@dataclass(frozen=True)
class IngestionResult:
    collection_id: str
    start_utc: str
    stop_utc: str
    raw_file: str
    info_file: str
    checksum_sha256: str
    processed_files: list[str]
    row_count_raw: int
    row_count_processed: int
    skipped_existing: bool
    manifest_entry_id: str


def _parse_utc(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("timestamps must include UTC or another explicit timezone")
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _compact(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
        handle.write(payload)
        temp = Path(handle.name)
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _data_path(data_root: Path, value: str) -> Path:
    candidate = Path(value)
    return candidate if candidate.is_absolute() else data_root / candidate


class ViresHapiClient:
    def __init__(
        self,
        base_url: str = VIRES_HAPI_BASE_URL,
        *,
        timeout_seconds: float = 60.0,
        retries: int = 3,
        retry_delay_seconds: float = 1.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        if not self.base_url.startswith("https://"):
            raise ValueError("VirES HAPI base URL must use HTTPS")
        self.timeout_seconds = timeout_seconds
        self.retries = max(1, int(retries))
        self.retry_delay_seconds = max(0.0, retry_delay_seconds)

    def _request(self, endpoint: str, params: Mapping[str, str]) -> tuple[str, bytes]:
        url = f"{self.base_url}/{endpoint}?{urllib.parse.urlencode(params)}"
        last_error: Exception | None = None
        for attempt in range(self.retries):
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                    return url, response.read()
            except urllib.error.HTTPError as exc:
                last_error = exc
                if exc.code < 500 or attempt + 1 >= self.retries:
                    break
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = exc
                if attempt + 1 >= self.retries:
                    break
            time.sleep(self.retry_delay_seconds * (2**attempt))
        raise RuntimeError(f"VirES HAPI request failed: {url}: {last_error}")

    @staticmethod
    def _decode(payload: bytes, label: str) -> dict[str, Any]:
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{label} did not return JSON: {exc}") from exc
        if not isinstance(decoded, dict):
            raise ValueError(f"{label} response must be a JSON object")
        status = decoded.get("status") or {}
        if status.get("code") not in (None, 1200):
            raise RuntimeError(f"{label} returned HAPI status {status}")
        return decoded

    def info(self, collection_id: str) -> tuple[str, bytes, dict[str, Any]]:
        collection_for(collection_id)
        url, payload = self._request("info", {"dataset": collection_id})
        return url, payload, self._decode(payload, "HAPI info")

    def data(
        self,
        collection_id: str,
        start: datetime,
        stop: datetime,
        parameter_names: Iterable[str],
    ) -> tuple[str, bytes, dict[str, Any]]:
        collection_for(collection_id)
        if stop <= start:
            raise ValueError("stop must be after start")
        url, payload = self._request("data", {
            "dataset": collection_id,
            "parameters": ",".join(parameter_names),
            "start": _iso(start),
            "stop": _iso(stop),
            "format": "json",
            "include": "header",
        })
        return url, payload, self._decode(payload, "HAPI data")


def _advertised_parameters(info: Mapping[str, Any]) -> list[str]:
    available = [
        str(item.get("name")) for item in info.get("parameters", [])
        if isinstance(item, Mapping) and item.get("name")
    ]
    selected = [name for name in DEFAULT_PARAMETERS if name in available]
    required = {"Timestamp", "Latitude_GD", "Longitude_GD", "Height_GD", "density"}
    if not required.issubset(selected):
        raise ValueError(f"VirES metadata lacks required density parameters: {sorted(required - set(selected))}")
    return selected


def _max_days(info: Mapping[str, Any]) -> int:
    value = str(info.get("x_maxTimeSelection") or "")
    match = re.fullmatch(r"P(\d+)D", value)
    return int(match.group(1)) if match else 1


def _chunks(start: datetime, stop: datetime, days: int) -> Iterable[tuple[datetime, datetime]]:
    cursor = start
    delta = timedelta(days=max(1, days))
    while cursor < stop:
        chunk_stop = min(stop, cursor + delta)
        yield cursor, chunk_stop
        cursor = chunk_stop


PROCESSING_VERSION = "one-minute-v2-circular-coordinates"


def _raw_paths(
    paths: IngestionPaths,
    collection_id: str,
    start: datetime,
    stop: datetime,
    data_checksum: str,
    info_checksum: str,
) -> tuple[Path, Path]:
    collection = collection_for(collection_id)
    directory = (
        paths.raw_root / collection.mission / collection_id /
        f"year={start.year:04d}" / f"month={start.month:02d}"
    )
    stem = (
        f"{collection_id}_{_compact(start)}_{_compact(stop)}"
        f"-{data_checksum[:12]}-{info_checksum[:12]}"
    )
    return directory / f"{stem}.hapi.json", directory / f"{stem}.info.json"


def _quality_aggregate(values: pd.Series) -> object:
    numeric = pd.to_numeric(values, errors="coerce").dropna()
    return pd.NA if numeric.empty else int(numeric.max())


def _circular_mean(values: pd.Series, period: float) -> float:
    numeric = pd.to_numeric(values, errors="coerce").dropna().to_numpy(float)
    numeric = numeric[np.isfinite(numeric)]
    if numeric.size == 0:
        return float("nan")
    angle = numeric * (2.0 * np.pi / period)
    sine = float(np.mean(np.sin(angle)))
    cosine = float(np.mean(np.cos(angle)))
    if np.hypot(sine, cosine) < 1e-12:
        return float("nan")
    result = float(np.arctan2(sine, cosine) * (period / (2.0 * np.pi)) % period)
    return 0.0 if np.isclose(result, period, atol=1e-12) else result


def resample_one_minute(frame: pd.DataFrame) -> pd.DataFrame:
    """Median density and conservative quality on UTC one-minute bins."""

    if frame.empty:
        return frame.copy()
    work = frame.sort_values("timestamp_utc").copy()
    work["timestamp_utc"] = pd.to_datetime(work["timestamp_utc"], utc=True, errors="coerce")
    work = work.dropna(subset=["timestamp_utc"])
    work["_minute"] = work["timestamp_utc"].dt.floor("min")
    rows: list[dict[str, Any]] = []
    for minute, group in work.groupby("_minute", sort=True):
        first = group.iloc[0]
        density = pd.to_numeric(group["rho_obs_kg_m3"], errors="coerce")
        valid_density = density[np.isfinite(density) & (density > 0)]
        uncertainty = pd.to_numeric(group["rho_uncertainty_kg_m3"], errors="coerce")
        directions = group["orbit_direction"].dropna().astype(str)
        row = {column: first[column] for column in CANONICAL_DENSITY_COLUMNS}
        row.update({
            "timestamp_utc": minute,
            "latitude_deg": pd.to_numeric(group["latitude_deg"], errors="coerce").mean(),
            "longitude_deg": ((_circular_mean(group["longitude_deg"], 360.0) + 180.0) % 360.0) - 180.0,
            "altitude_km": pd.to_numeric(group["altitude_km"], errors="coerce").mean(),
            "local_solar_time_h": _circular_mean(group["local_solar_time_h"], 24.0),
            "rho_obs_kg_m3": valid_density.median() if not valid_density.empty else np.nan,
            "rho_uncertainty_kg_m3": uncertainty.median() if uncertainty.notna().any() else np.nan,
            "quality_flag": _quality_aggregate(group["quality_flag"]),
            "orbit_direction": directions.mode().iloc[0] if not directions.empty else None,
            "native_samples_in_bin": int(len(group)),
        })
        rows.append(row)
    out = pd.DataFrame(rows).sort_values("timestamp_utc").reset_index(drop=True)
    elapsed = out["timestamp_utc"].diff().dt.total_seconds()
    out["gap_duration_s"] = (elapsed - 60.0).clip(lower=0).fillna(0.0)
    out["processed_cadence_s"] = 60
    out["processed_at_utc"] = pd.to_datetime(utc_now_iso(), utc=True)
    out["quality_status"] = np.select(
        [out["quality_flag"].eq(0), out["quality_flag"].notna()],
        ["nominal", "anomalous"],
        default="not_provided",
    )
    return out


def _write_processed_partitions(
    frame: pd.DataFrame,
    *,
    paths: IngestionPaths,
    collection_id: str,
    checksum: str,
    start: datetime,
    stop: datetime,
) -> tuple[list[Path], bool]:
    if frame.empty:
        return [], False
    collection = collection_for(collection_id)
    output: list[Path] = []
    all_existed = True
    working = frame.copy()
    timestamp = pd.to_datetime(working["timestamp_utc"], utc=True)
    working["_year"] = timestamp.dt.year
    working["_month"] = timestamp.dt.month
    for (year, month), partition in working.groupby(["_year", "_month"], sort=True):
        directory = paths.processed_root / f"mission={collection.mission}" / f"year={int(year):04d}" / f"month={int(month):02d}"
        name = (
            f"part-{collection_id}-{_compact(start)}-{_compact(stop)}-"
            f"{checksum[:12]}-{PROCESSING_VERSION}.parquet"
        )
        destination = directory / name
        output.append(destination)
        if destination.exists():
            continue
        all_existed = False
        directory.mkdir(parents=True, exist_ok=True)
        clean = partition.drop(columns=["_year", "_month"])
        temp = destination.with_suffix(".parquet.tmp")
        clean.to_parquet(temp, index=False, engine="pyarrow")
        os.replace(temp, destination)
    return output, all_existed


def _entry_id(collection_id: str, start: datetime, stop: datetime) -> str:
    raw = f"{collection_id}|{_iso(start)}|{_iso(stop)}".encode()
    return hashlib.sha256(raw).hexdigest()[:24]


def process_raw_pair(
    *,
    collection_id: str,
    data_file: str | Path,
    info_file: str | Path,
    source_url: str,
    start: datetime,
    stop: datetime,
    paths: IngestionPaths,
) -> IngestionResult:
    data_path = Path(data_file).resolve()
    info_path = Path(info_file).resolve()
    data_bytes = data_path.read_bytes()
    info_bytes = info_path.read_bytes()
    try:
        response = json.loads(data_bytes)
        info = json.loads(info_bytes)
    except json.JSONDecodeError as exc:
        raise ValueError(f"manual/raw import is not valid HAPI JSON: {exc}") from exc
    if not isinstance(response, dict) or not isinstance(info, dict):
        raise ValueError("HAPI data and info files must each contain one JSON object")
    checksum = sha256_bytes(data_bytes)
    info_checksum = sha256_bytes(info_bytes)
    stable_id = _entry_id(collection_id, start, stop)
    manifest = load_manifest(paths.manifest_path)
    existing = next(
        (
            item for item in manifest.get("entries", [])
            if isinstance(item, Mapping) and item.get("id") == stable_id
        ),
        None,
    )
    if existing is not None:
        existing_data_checksum = existing.get("checksum_sha256")
        existing_info_checksum = existing.get("info_checksum_sha256")
        if existing_data_checksum and existing_data_checksum != checksum:
            raise ValueError(
                "official source bytes changed for an already ingested interval; "
                "use a new reviewed data root instead of overwriting lineage"
            )
        if existing_info_checksum and existing_info_checksum != info_checksum:
            raise ValueError(
                "official source metadata changed for an already ingested interval; "
                "use a new reviewed data root instead of overwriting lineage"
            )
    frame, validation = normalize_hapi_response(
        collection_id=collection_id,
        info=info,
        response=response,
        source_file=data_path,
        source_url=source_url,
        checksum_sha256=checksum,
    )
    if not validation.get("ok", False):
        raise ValueError(f"canonical validation failed: {validation.get('errors')}")
    processed = resample_one_minute(frame)
    processed_paths, all_existed = _write_processed_partitions(
        processed, paths=paths, collection_id=collection_id, checksum=checksum,
        start=start, stop=stop,
    )
    collection = collection_for(collection_id)
    quality = pd.to_numeric(frame["quality_flag"], errors="coerce") if not frame.empty else pd.Series(dtype=float)
    raw_storage = data_path.stat().st_size + info_path.stat().st_size
    processed_storage = sum(path.stat().st_size for path in processed_paths if path.exists())
    source_version = info.get("x_version") or info.get("version")
    entry = {
        "id": stable_id,
        "schema_version": "thermosphere-density-v1",
        "mission": collection.mission,
        "mission_label": collection.mission_label,
        "spacecraft_id": collection.spacecraft_id,
        "source_product": collection_id,
        "product_family": collection.product_family,
        "source_version": str(source_version) if source_version else None,
        "source_provider": "ESA / VirES for Swarm",
        "source_url": source_url,
        "raw_file": str(data_path.relative_to(paths.data_root)) if data_path.is_relative_to(paths.data_root) else str(data_path),
        "info_file": str(info_path.relative_to(paths.data_root)) if info_path.is_relative_to(paths.data_root) else str(info_path),
        "processed_files": [
            str(path.relative_to(paths.data_root)) if path.is_relative_to(paths.data_root) else str(path)
            for path in processed_paths
        ],
        "checksum_sha256": checksum,
        "info_checksum_sha256": info_checksum,
        "processing_version": PROCESSING_VERSION,
        "start_utc": _iso(start),
        "end_utc": _iso(stop),
        "row_count_raw": int(len(frame)),
        "row_count_processed": int(len(processed)),
        "native_cadence_seconds": collection.native_cadence_seconds,
        "processed_cadence_seconds": 60,
        "quality_nominal_rows": int(quality.eq(0).sum()),
        "quality_anomalous_rows": int(quality.notna().sum() - quality.eq(0).sum()),
        "quality_not_provided_rows": int(quality.isna().sum()),
        "invalid_or_fill_density_rows": int(validation.get("fill_or_invalid_density_rows", 0)),
        "storage_bytes": int(raw_storage + processed_storage),
        "last_ingestion_utc": utc_now_iso(),
        "processing_status": "processed",
        "baseline_status": "pending",
        "driver_join_status": "pending",
        "training_role": None,
        "error": None,
        "provenance": {
            "catalog_modified_at_utc": info.get("modificationDate"),
            "catalog_start_utc": info.get("startDate"),
            "catalog_stop_utc": info.get("stopDate"),
            "hapi_version": info.get("HAPI"),
            "data_terms": info.get("x_dataTerms") or "https://vires.services/data_terms",
            "attribution": "Data provided by the European Space Agency.",
            "copyright": f"© ESA ({datetime.now(timezone.utc).year})",
            "evidence_class": "observed_retrospective_product",
            "validation": validation,
        },
    }
    upsert_manifest_entry(paths.manifest_path, entry)
    return IngestionResult(
        collection_id=collection_id, start_utc=_iso(start), stop_utc=_iso(stop),
        raw_file=str(data_path), info_file=str(info_path), checksum_sha256=checksum,
        processed_files=[str(path) for path in processed_paths],
        row_count_raw=len(frame), row_count_processed=len(processed),
        skipped_existing=all_existed, manifest_entry_id=stable_id,
    )


def ingest_collection(
    collection_id: str,
    start: str | datetime,
    stop: str | datetime,
    *,
    data_root: str | Path = "data",
    client: ViresHapiClient | None = None,
    chunk_days: int = 7,
) -> list[IngestionResult]:
    collection_for(collection_id)
    start_dt, stop_dt = _parse_utc(start), _parse_utc(stop)
    if stop_dt <= start_dt:
        raise ValueError("stop must be after start (HAPI stop is exclusive)")
    paths = IngestionPaths.from_data_root(data_root)
    hapi = client or ViresHapiClient()
    info_url, info_bytes, info = hapi.info(collection_id)
    advertised_start = _parse_utc(info["startDate"]) if info.get("startDate") else None
    advertised_stop = _parse_utc(info["stopDate"]) if info.get("stopDate") else None
    if advertised_start and start_dt < advertised_start:
        raise ValueError(f"requested start precedes catalog coverage {info['startDate']}")
    if advertised_stop and stop_dt > advertised_stop + timedelta(seconds=collection_for(collection_id).native_cadence_seconds):
        raise ValueError(f"requested stop exceeds catalog coverage {info['stopDate']}")
    parameters = _advertised_parameters(info)
    safe_days = min(max(1, int(chunk_days)), max(1, _max_days(info) - 1))
    results: list[IngestionResult] = []
    for chunk_start, chunk_stop in _chunks(start_dt, stop_dt, safe_days):
        try:
            # A completed immutable interval can be resumed without another
            # large HAPI data transfer.  The lightweight info request above is
            # still made so current catalogue bounds and parameters are
            # validated before trusting local bytes.
            stable_id = _entry_id(collection_id, chunk_start, chunk_stop)
            manifest = load_manifest(paths.manifest_path)
            existing = next(
                (
                    item for item in manifest.get("entries", [])
                    if isinstance(item, Mapping) and item.get("id") == stable_id
                ),
                None,
            )
            # Explicitly injected clients are normally tests/import tools and
            # must still exercise source-revision detection.
            if existing is not None and client is None:
                raw_value = existing.get("raw_file")
                info_value = existing.get("info_file")
                processed_values = existing.get("processed_files") or []
                raw_path = _data_path(paths.data_root, str(raw_value)) if raw_value else None
                info_path = _data_path(paths.data_root, str(info_value)) if info_value else None
                processed_paths = [
                    _data_path(paths.data_root, str(value)) for value in processed_values
                ]
                if (
                    raw_path is not None
                    and info_path is not None
                    and raw_path.is_file()
                    and info_path.is_file()
                    and processed_paths
                    and all(path.is_file() for path in processed_paths)
                ):
                    results.append(IngestionResult(
                        collection_id=collection_id,
                        start_utc=_iso(chunk_start),
                        stop_utc=_iso(chunk_stop),
                        raw_file=str(raw_path),
                        info_file=str(info_path),
                        checksum_sha256=str(existing.get("checksum_sha256") or ""),
                        processed_files=[str(path) for path in processed_paths],
                        row_count_raw=int(existing.get("row_count_raw") or 0),
                        row_count_processed=int(existing.get("row_count_processed") or 0),
                        skipped_existing=True,
                        manifest_entry_id=stable_id,
                    ))
                    continue
            data_url, data_bytes, _ = hapi.data(collection_id, chunk_start, chunk_stop, parameters)
            data_path, info_path = _raw_paths(
                paths, collection_id, chunk_start, chunk_stop,
                sha256_bytes(data_bytes), sha256_bytes(info_bytes),
            )
            _atomic_bytes(data_path, data_bytes)
            _atomic_bytes(info_path, info_bytes)
            results.append(process_raw_pair(
                collection_id=collection_id, data_file=data_path, info_file=info_path,
                source_url=data_url, start=chunk_start, stop=chunk_stop, paths=paths,
            ))
        except Exception as exc:
            append_manifest_error(paths.manifest_path, {
                "collection_id": collection_id, "start_utc": _iso(chunk_start),
                "stop_utc": _iso(chunk_stop), "error": f"{type(exc).__name__}: {exc}",
                "info_url": info_url,
            })
            raise
    return results


def import_hapi_files(
    collection_id: str,
    *,
    data_file: str | Path,
    info_file: str | Path,
    start: str | datetime,
    stop: str | datetime,
    source_url: str,
    data_root: str | Path = "data",
) -> IngestionResult:
    """Strict manual import fallback for previously downloaded official HAPI JSON."""

    collection_for(collection_id)
    if not source_url.startswith("https://vires.services/hapi/"):
        raise ValueError("manual import source_url must identify the official VirES HAPI service")
    paths = IngestionPaths.from_data_root(data_root)
    start_utc, stop_utc = _parse_utc(start), _parse_utc(stop)
    source_data = Path(data_file).resolve().read_bytes()
    source_info = Path(info_file).resolve().read_bytes()
    archived_data, archived_info = _raw_paths(
        paths, collection_id, start_utc, stop_utc,
        sha256_bytes(source_data), sha256_bytes(source_info),
    )
    if not archived_data.exists():
        _atomic_bytes(archived_data, source_data)
    if not archived_info.exists():
        _atomic_bytes(archived_info, source_info)
    return process_raw_pair(
        collection_id=collection_id, data_file=archived_data, info_file=archived_info,
        source_url=source_url, start=start_utc, stop=stop_utc, paths=paths,
    )


def discover_collections(client: ViresHapiClient | None = None) -> list[dict[str, Any]]:
    hapi = client or ViresHapiClient()
    output: list[dict[str, Any]] = []
    for collection_id, definition in COLLECTIONS.items():
        try:
            url, _, info = hapi.info(collection_id)
            output.append({
                **asdict(definition), "status": "available" if info.get("startDate") else "unavailable",
                "start_utc": info.get("startDate"), "stop_utc": info.get("stopDate"),
                "catalog_modified_at_utc": info.get("modificationDate"), "info_url": url,
            })
        except Exception as exc:  # discovery reports per-source errors without inventing coverage
            output.append({**asdict(definition), "status": "error", "error": str(exc)})
    output.append({
        "collection_id": "GF_OPER_DNS2ACC_2_", "mission": "grace_fo",
        "mission_label": "GRACE-FO", "spacecraft_id": "2",
        "product_family": "GF_DNSxACC_2_", "native_cadence_seconds": 10,
        "quality_flag_available": True, "official_density_product": False,
        "status": "unavailable", "error": "No GRACE-FO 2 density collection in the current VirES HAPI catalog",
    })
    return output

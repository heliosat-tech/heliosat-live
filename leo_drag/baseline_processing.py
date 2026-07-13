"""Apply the research atmosphere baseline to canonical mission observations."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

import pandas as pd

from .ancillary import (
    AncillarySnapshot,
    F107aMode,
    forcing_for_timestamps,
    load_omni2_forcing,
)
from .baseline import AtmosphereInput, PymsisBaseline
from .manifest import load_manifest, upsert_manifest_entry, utc_now_iso


@dataclass(frozen=True)
class BaselineProcessingReport:
    manifest_entry_id: str
    source_product: str
    input_rows: int
    successful_rows: int
    unavailable_rows: int
    status_counts: dict[str, int]
    output_files: list[str]
    baseline_model: str
    baseline_version: str | None
    f107a_mode: F107aMode
    ancillary_checksums_sha256: dict[str, str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "manifest_entry_id": self.manifest_entry_id,
            "source_product": self.source_product,
            "input_rows": self.input_rows,
            "successful_rows": self.successful_rows,
            "unavailable_rows": self.unavailable_rows,
            "status_counts": self.status_counts,
            "output_files": self.output_files,
            "baseline_model": self.baseline_model,
            "baseline_version": self.baseline_version,
            "f107a_mode": self.f107a_mode,
            "ancillary_checksums_sha256": self.ancillary_checksums_sha256,
        }


def research_license_enabled(explicit: bool = False) -> bool:
    value = os.getenv("HELIOSAT_ENABLE_NRLMSIS_RESEARCH", "").strip().lower()
    return explicit and value in {"1", "true", "yes", "on"}


def _data_path(data_root: Path, value: str) -> Path:
    candidate = Path(value)
    return candidate if candidate.is_absolute() else data_root / candidate


def _forcing_ap(row: pd.Series) -> list[float | None]:
    values: list[float | None] = []
    for column in (
        "ap_daily",
        "ap_current",
        "ap_3h_before",
        "ap_6h_before",
        "ap_9h_before",
        "ap_12_33h_mean",
        "ap_36_57h_mean",
    ):
        value = pd.to_numeric(pd.Series([row.get(column)]), errors="coerce").iloc[0]
        values.append(float(value) if pd.notna(value) else None)
    return values


def _atomic_parquet(frame: pd.DataFrame, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "wb", dir=destination.parent, prefix=f".{destination.name}.",
        suffix=".parquet.tmp", delete=False,
    ) as handle:
        temporary = Path(handle.name)
    try:
        frame.to_parquet(temporary, index=False, engine="pyarrow")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_json(payload: Mapping[str, Any], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    body = (json.dumps(dict(payload), indent=2, sort_keys=True) + "\n").encode("utf-8")
    with tempfile.NamedTemporaryFile(
        "wb", dir=destination.parent, prefix=f".{destination.name}.",
        suffix=".tmp", delete=False,
    ) as handle:
        handle.write(body)
        temporary = Path(handle.name)
    try:
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def apply_baseline_to_frame(
    observations: pd.DataFrame,
    forcing: pd.DataFrame,
    *,
    baseline: PymsisBaseline,
    ancillary: AncillarySnapshot,
) -> pd.DataFrame:
    """Return observations plus explicit forcing and row-level model status."""

    required = {"timestamp_utc", "latitude_deg", "longitude_deg", "altitude_km"}
    missing = required - set(observations.columns)
    if missing:
        raise ValueError(f"processed density frame is missing {sorted(missing)}")
    output = observations.copy().reset_index(drop=True)
    aligned = forcing_for_timestamps(output["timestamp_utc"], forcing)
    forcing_columns = [column for column in aligned.columns if column != "timestamp_utc"]
    for column in forcing_columns:
        output[column] = aligned[column].to_numpy()
    # Canonical feature name; the more explicit source column is retained.
    # NRLMSIS expects the previous day's daily F10.7 at each requested time.
    output["f107_sfu"] = output["f107_previous_day_sfu"]

    inputs: list[AtmosphereInput] = []
    for _, row in output.iterrows():
        ap = _forcing_ap(row)
        inputs.append(AtmosphereInput(
            timestamp_utc=row["timestamp_utc"],
            latitude_deg=row.get("latitude_deg"),
            longitude_deg=row.get("longitude_deg"),
            altitude_km=row.get("altitude_km"),
            f107_sfu=row.get("f107_previous_day_sfu"),
            f107a_sfu=row.get("f107a_sfu"),
            ap=ap,
            local_solar_time_h=row.get("local_solar_time_h"),
            ancillary_source="NASA SPDF OMNI2 hourly",
            ancillary_version="exact yearly ASCII snapshot",
            # OMNI2 publication latency is not an issuance-safe feed; no false
            # availability timestamp is asserted for this retrospective run.
            ancillary_available_at_utc=None,
        ))
    results = baseline.predict_many(inputs)
    if len(results) != len(output):
        raise RuntimeError("baseline adapter returned a different number of rows")
    output["rho_baseline_kg_m3"] = [result.rho_baseline_kg_m3 for result in results]
    output["baseline_model_name"] = [result.baseline_model_name for result in results]
    output["baseline_model_version"] = [result.baseline_model_version for result in results]
    output["baseline_input_status"] = [result.baseline_input_status for result in results]
    output["baseline_research_only"] = [result.research_only for result in results]
    output["baseline_license_warning"] = [result.license_warning for result in results]
    output["baseline_error"] = [result.error for result in results]
    output["baseline_calculated_at_utc"] = pd.to_datetime(utc_now_iso(), utc=True)
    output["baseline_evidence_class"] = "retrospective_physical_baseline"
    output["baseline_ancillary_availability"] = ancillary.availability_class
    output["baseline_ancillary_checksums_json"] = json.dumps(
        ancillary.checksums_sha256, sort_keys=True, separators=(",", ":")
    )
    return output


def process_manifest_entry_baseline(
    entry: Mapping[str, Any],
    *,
    data_root: str | Path = "data",
    acknowledge_research_license: bool = False,
    refresh_ancillary: bool = False,
    f107a_mode: F107aMode = "trailing_81_day",
) -> BaselineProcessingReport:
    root = Path(data_root).resolve()
    manifest_path = root / "processed" / "thermosphere" / "manifest.v1.json"
    source_files = [_data_path(root, str(value)) for value in entry.get("processed_files") or []]
    if not source_files:
        raise ValueError(f"manifest entry {entry.get('id')} has no processed files")
    frames = [pd.read_parquet(path) for path in source_files]
    timestamps = pd.concat(
        [pd.to_datetime(frame["timestamp_utc"], utc=True, errors="coerce") for frame in frames],
        ignore_index=True,
    ).dropna()
    if timestamps.empty:
        raise ValueError(f"manifest entry {entry.get('id')} has no valid UTC rows")
    forcing, ancillary = load_omni2_forcing(
        timestamps.min(), timestamps.max() + pd.Timedelta(minutes=1),
        data_root=root, refresh=refresh_ancillary, f107a_mode=f107a_mode,
    )
    baseline = PymsisBaseline(
        allow_research_use=research_license_enabled(acknowledge_research_license)
    )
    outputs: list[Path] = []
    status_counts: dict[str, int] = {}
    input_rows = 0
    for source, frame in zip(source_files, frames, strict=True):
        augmented = apply_baseline_to_frame(
            frame, forcing, baseline=baseline, ancillary=ancillary
        )
        input_rows += len(augmented)
        for status, count in augmented["baseline_input_status"].value_counts(dropna=False).items():
            key = str(status)
            status_counts[key] = status_counts.get(key, 0) + int(count)
        try:
            relative = source.relative_to(root / "processed" / "thermosphere")
        except ValueError:
            relative = Path(source.name)
        # Keep retrospective centered and causal trailing baselines physically
        # separate so a new headline run cannot silently overwrite an older
        # pilot's forcing definition.
        destination = (
            root / "processed" / "thermosphere-baseline" / f107a_mode / relative
        )
        _atomic_parquet(augmented, destination)
        outputs.append(destination)

    successful = status_counts.get("ok", 0)
    processing_status = (
        "processed" if successful == input_rows
        else "partial" if successful > 0
        else "unavailable"
    )
    metadata_payload = {
        "schema_version": "thermosphere-baseline-v1",
        "generated_at_utc": utc_now_iso(),
        "manifest_entry_id": entry.get("id"),
        "source_product": entry.get("source_product"),
        "baseline_model": baseline.model_name,
        "baseline_version": baseline.model_version,
        "f107a_mode": f107a_mode,
        "forecast_causal_f107a": f107a_mode == "trailing_81_day",
        "research_only": True,
        "license_acknowledged_for_run": baseline.allow_research_use,
        "ancillary": ancillary.to_dict(),
        "status_counts": status_counts,
        "input_rows": input_rows,
        "successful_rows": successful,
    }
    metadata_bytes = json.dumps(metadata_payload, sort_keys=True).encode("utf-8")
    metadata_checksum = hashlib.sha256(metadata_bytes).hexdigest()
    metadata_path = outputs[0].parent / f"baseline-{entry.get('id')}-{metadata_checksum[:12]}.metadata.json"
    _atomic_json(metadata_payload, metadata_path)

    updated = dict(entry)
    updated.update({
        "baseline_status": processing_status,
        "baseline_rows_ok": successful,
        "baseline_rows_unavailable": input_rows - successful,
        "baseline_status_counts": status_counts,
        "baseline_files": [
            str(path.relative_to(root)) if path.is_relative_to(root) else str(path)
            for path in outputs
        ],
        "baseline_metadata_file": (
            str(metadata_path.relative_to(root)) if metadata_path.is_relative_to(root)
            else str(metadata_path)
        ),
        "baseline_model_name": baseline.model_name,
        "baseline_model_version": baseline.model_version,
        "baseline_f107a_mode": f107a_mode,
        "baseline_forecast_causal_f107a": f107a_mode == "trailing_81_day",
        "baseline_research_only": True,
        "baseline_license_status": "unreviewed_internal_research",
        "baseline_ancillary": ancillary.to_dict(),
        "baseline_last_run_utc": utc_now_iso(),
    })
    upsert_manifest_entry(manifest_path, updated)
    return BaselineProcessingReport(
        manifest_entry_id=str(entry.get("id")),
        source_product=str(entry.get("source_product")),
        input_rows=input_rows,
        successful_rows=successful,
        unavailable_rows=input_rows - successful,
        status_counts=status_counts,
        output_files=[str(path) for path in outputs],
        baseline_model=baseline.model_name,
        baseline_version=baseline.model_version,
        f107a_mode=f107a_mode,
        ancillary_checksums_sha256=ancillary.checksums_sha256,
    )


def process_all_baselines(
    *,
    data_root: str | Path = "data",
    collection_ids: Iterable[str] | None = None,
    manifest_entry_ids: Iterable[str] | None = None,
    acknowledge_research_license: bool = False,
    refresh_ancillary: bool = False,
    f107a_mode: F107aMode = "trailing_81_day",
) -> list[BaselineProcessingReport]:
    root = Path(data_root).resolve()
    manifest_path = root / "processed" / "thermosphere" / "manifest.v1.json"
    manifest = load_manifest(manifest_path)
    selected = set(collection_ids or [])
    selected_entries = set(manifest_entry_ids or [])
    entries = [
        entry for entry in manifest.get("entries", [])
        if isinstance(entry, dict)
        and (not selected or str(entry.get("source_product")) in selected)
        and (not selected_entries or str(entry.get("id")) in selected_entries)
    ]
    reports: list[BaselineProcessingReport] = []
    # Reload the entry before each upsert is unnecessary: source fields are
    # immutable, while each entry has a distinct stable id.
    for entry in entries:
        reports.append(process_manifest_entry_baseline(
            entry,
            data_root=root,
            acknowledge_research_license=acknowledge_research_license,
            refresh_ancillary=refresh_ancillary,
            f107a_mode=f107a_mode,
        ))
    return reports

"""Local thermosphere archive inventory derived from the lineage manifest."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable, Mapping

from .manifest import load_manifest, utc_now_iso
from .schema import COLLECTIONS, UNAVAILABLE_COLLECTIONS, DensityCollection


def _paths(data_root: Path, values: Iterable[object]) -> list[Path]:
    output: list[Path] = []
    for value in values:
        candidate = Path(str(value))
        output.append(candidate if candidate.is_absolute() else data_root / candidate)
    return output


def _actual_size(paths: Iterable[Path]) -> int:
    return sum(path.stat().st_size for path in paths if path.is_file())


def _combined_status(entries: list[Mapping[str, Any]], field: str, empty: str = "pending") -> str:
    values = {str(entry.get(field) or empty) for entry in entries}
    if not values:
        return empty
    if len(values) == 1:
        return values.pop()
    if "partial" in values or ("processed" in values and values - {"processed"}):
        return "partial"
    if values <= {"pending", "unavailable"} and "unavailable" in values:
        return "unavailable"
    return "mixed"


def _dataset_card(
    definition: DensityCollection,
    entries: list[Mapping[str, Any]],
    data_root: Path,
) -> dict[str, Any]:
    raw_paths = _paths(data_root, [entry.get("raw_file") for entry in entries if entry.get("raw_file")])
    processed_paths = _paths(
        data_root,
        [value for entry in entries for value in entry.get("processed_files") or []],
    )
    baseline_paths = _paths(
        data_root,
        [value for entry in entries for value in entry.get("baseline_files") or []],
    )
    nominal = sum(int(entry.get("quality_nominal_rows") or 0) for entry in entries)
    anomalous = sum(int(entry.get("quality_anomalous_rows") or 0) for entry in entries)
    flagged = nominal + anomalous
    available = bool(entries)
    coverage_start = min(
        (str(entry.get("start_utc")) for entry in entries if entry.get("start_utc")),
        default=None,
    )
    coverage_end = max(
        (str(entry.get("end_utc")) for entry in entries if entry.get("end_utc")),
        default=None,
    )
    last_ingestion = max(
        (str(entry.get("last_ingestion_utc")) for entry in entries if entry.get("last_ingestion_utc")),
        default=None,
    )
    return {
        **asdict(definition),
        "status": "available_local" if available else "not_imported",
        "coverage_start_utc": coverage_start,
        "coverage_end_utc": coverage_end,
        "raw_files": len([path for path in raw_paths if path.is_file()]),
        "processed_files": len([path for path in processed_paths if path.is_file()]),
        "baseline_files": len([path for path in baseline_paths if path.is_file()]),
        "row_count_raw": sum(int(entry.get("row_count_raw") or 0) for entry in entries),
        "row_count_processed": sum(int(entry.get("row_count_processed") or 0) for entry in entries),
        "local_storage_bytes": _actual_size([*raw_paths, *processed_paths, *baseline_paths]),
        "last_successful_ingestion_utc": last_ingestion,
        "quality_nominal_fraction": nominal / flagged if flagged else None,
        "quality_flag_coverage_fraction": (
            flagged / max(1, sum(int(entry.get("row_count_raw") or 0) for entry in entries))
            if entries else None
        ),
        "processing_status": _combined_status(entries, "processing_status", "not_started"),
        "baseline_status": _combined_status(entries, "baseline_status"),
        "driver_join_status": _combined_status(entries, "driver_join_status"),
        "training_roles": sorted({
            str(entry.get("training_role")) for entry in entries if entry.get("training_role")
        }),
        "entry_ids": [str(entry.get("id")) for entry in entries],
        "source_attribution": "Data provided by the European Space Agency.",
        "evidence_class": "observed_retrospective_product" if available else "metadata_only",
    }


def build_inventory(data_root: str | Path = "data") -> dict[str, Any]:
    root = Path(data_root).resolve()
    manifest_path = root / "processed" / "thermosphere" / "manifest.v1.json"
    manifest = load_manifest(manifest_path)
    manifest_entries = [entry for entry in manifest.get("entries", []) if isinstance(entry, dict)]
    datasets: list[dict[str, Any]] = []
    for collection_id, definition in COLLECTIONS.items():
        matching = [
            entry for entry in manifest_entries
            if entry.get("source_product") == collection_id
        ]
        datasets.append(_dataset_card(definition, matching, root))
    for definition in UNAVAILABLE_COLLECTIONS.values():
        card = _dataset_card(definition, [], root)
        card.update({
            "status": "official_product_unavailable",
            "processing_status": "unavailable",
            "baseline_status": "unavailable",
            "driver_join_status": "unavailable",
            "unavailable_reason": (
                "No GRACE-FO 2 thermospheric density collection is present "
                "in the verified VirES HAPI catalog."
            ),
        })
        datasets.append(card)

    coverage = {
        "segments": [
            {
                "entry_id": entry.get("id"),
                "mission": entry.get("mission"),
                "spacecraft_id": entry.get("spacecraft_id"),
                "source_product": entry.get("source_product"),
                "start_utc": entry.get("start_utc"),
                "end_utc": entry.get("end_utc"),
                "raw": bool(entry.get("raw_file")),
                "processed": entry.get("processing_status") == "processed",
                "baseline": entry.get("baseline_status") in {"processed", "partial"},
                "joined": entry.get("driver_join_status") in {"processed", "partial"},
                "role": entry.get("training_role"),
            }
            for entry in manifest_entries
        ],
        "manifest_path": str(manifest_path),
        "manifest_schema_version": manifest.get("schema_version"),
    }
    return {
        "generated_at_utc": utc_now_iso(),
        "datasets": datasets,
        "coverage": coverage,
        "errors": manifest.get("errors") or [],
        "source": manifest.get("source") or {},
    }

"""Atomic, machine-readable lineage manifest for thermosphere ingestion."""

from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

MANIFEST_SCHEMA_VERSION = "thermosphere-manifest-v1"
DEFAULT_MANIFEST_RELATIVE_PATH = Path("processed/thermosphere/manifest.v1.json")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def empty_manifest() -> dict[str, Any]:
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "generated_at_utc": utc_now_iso(),
        "source": {
            "provider": "ESA / VirES for Swarm",
            "service": "https://vires.services/hapi/",
            "data_terms": "https://vires.services/data_terms",
            "attribution": "Data provided by the European Space Agency.",
            "licensing_status": "internal research; commercial redistribution not reviewed",
        },
        "entries": [],
        "errors": [],
    }


def load_manifest(path: str | Path) -> dict[str, Any]:
    manifest_path = Path(path)
    if not manifest_path.exists():
        return empty_manifest()
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read manifest {manifest_path}: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError(f"unsupported manifest schema in {manifest_path}")
    if not isinstance(payload.get("entries"), list):
        raise ValueError(f"manifest entries must be a list in {manifest_path}")
    payload.setdefault("errors", [])
    return payload


def write_manifest_atomic(path: str | Path, payload: Mapping[str, Any]) -> None:
    manifest_path = Path(path)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=manifest_path.parent, prefix=f".{manifest_path.name}.",
        suffix=".tmp", delete=False,
    ) as handle:
        handle.write(serialized)
        temp_path = Path(handle.name)
    try:
        os.replace(temp_path, manifest_path)
    finally:
        temp_path.unlink(missing_ok=True)


def upsert_manifest_entry(
    path: str | Path,
    entry: Mapping[str, Any],
    *,
    stable_key: str = "id",
) -> dict[str, Any]:
    if not entry.get(stable_key):
        raise ValueError(f"manifest entry requires {stable_key}")
    payload = load_manifest(path)
    updated = deepcopy(dict(entry))
    entries = [
        existing for existing in payload["entries"]
        if not isinstance(existing, dict) or existing.get(stable_key) != updated[stable_key]
    ]
    entries.append(updated)
    entries.sort(key=lambda item: (str(item.get("mission", "")), str(item.get("spacecraft_id", "")), str(item.get("start_utc", "")), str(item.get("source_product", ""))))
    payload["entries"] = entries
    payload["generated_at_utc"] = utc_now_iso()
    write_manifest_atomic(path, payload)
    return payload


def append_manifest_error(path: str | Path, error: Mapping[str, Any]) -> dict[str, Any]:
    payload = load_manifest(path)
    errors = list(payload.get("errors") or [])
    errors.append({**dict(error), "recorded_at_utc": utc_now_iso()})
    payload["errors"] = errors[-200:]
    payload["generated_at_utc"] = utc_now_iso()
    write_manifest_atomic(path, payload)
    return payload

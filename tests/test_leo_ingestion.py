from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from leo_drag.ingestion import ingest_collection, resample_one_minute
from leo_drag.manifest import load_manifest
from leo_drag.schema import (
    collection_for,
    normalize_hapi_response,
    usable_density_mask,
)


PARAMETERS = [
    {"name": "Timestamp"},
    {"name": "Latitude_GD"},
    {"name": "Longitude_GD"},
    {"name": "Height_GD"},
    {"name": "local_solar_time"},
    {"name": "density"},
    {"name": "density_orbitmean"},
    {"name": "validity_flag"},
]


def _info() -> dict[str, object]:
    return {
        "HAPI": "3.0",
        "parameters": PARAMETERS,
        "startDate": "2022-01-01T00:00:00Z",
        "stopDate": "2022-12-31T23:59:30Z",
        "x_maxTimeSelection": "P10D",
        "modificationDate": "2024-01-01T00:00:00Z",
    }


def _response() -> dict[str, object]:
    return {
        "HAPI": "3.0",
        "parameters": PARAMETERS,
        "data": [
            ["2022-02-03T00:00:00Z", 10, 20, 450_000, 5.0, 2e-12, 2e-12, 0],
            ["2022-02-03T00:00:30Z", 12, 22, 452_000, 5.1, 4e-12, 3e-12, 1],
            ["2022-02-03T00:02:00Z", -5, -170, 455_000, 6.0, 9.99e32, 2e-12, 0],
        ],
    }


def test_hapi_parser_normalizes_units_timestamps_fill_and_quality(tmp_path: Path) -> None:
    frame, report = normalize_hapi_response(
        collection_id="SW_OPER_DNSAPOD_2_",
        info=_info(),
        response=_response(),
        source_file=tmp_path / "raw.json",
        source_url="https://vires.services/hapi/data?dataset=SW_OPER_DNSAPOD_2_",
        checksum_sha256="a" * 64,
        ingested_at_utc="2026-01-01T00:00:00Z",
    )

    assert report["ok"] is True
    assert report["fill_or_invalid_density_rows"] == 1
    assert str(frame["timestamp_utc"].dt.tz) == "UTC"
    assert frame.loc[0, "altitude_km"] == pytest.approx(450.0)
    assert frame.loc[0, "rho_obs_kg_m3"] == pytest.approx(2e-12)
    assert pd.isna(frame.loc[2, "rho_obs_kg_m3"])
    assert frame["quality_flag"].tolist() == [0, 1, 0]
    assert set(frame["evidence_class"]) == {"observed"}


def test_hapi_parser_nulls_auxiliary_coordinate_fill_values(tmp_path: Path) -> None:
    response = _response()
    response["data"][0][1:5] = [9.99e31, 9.99e31, 9.99e31, 9.99e31]  # type: ignore[index]
    frame, report = normalize_hapi_response(
        collection_id="SW_OPER_DNSAPOD_2_",
        info=_info(),
        response=response,
        source_file=tmp_path / "raw.json",
        source_url="https://vires.services/hapi/data?dataset=SW_OPER_DNSAPOD_2_",
        checksum_sha256="f" * 64,
    )
    assert report["ok"] is True
    assert frame.loc[0, [
        "latitude_deg", "longitude_deg", "altitude_km", "local_solar_time_h"
    ]].isna().all()
    assert frame.loc[0, "rho_obs_kg_m3"] == pytest.approx(2e-12)


def test_quality_policy_never_treats_missing_flag_as_nominal() -> None:
    frame = pd.DataFrame({
        "rho_obs_kg_m3": [1e-12, 2e-12, 3e-12, np.nan],
        "quality_flag": pd.Series([0, 1, pd.NA, 0], dtype="Int64"),
    })
    assert usable_density_mask(frame).tolist() == [True, False, False, False]
    assert usable_density_mask(frame, allow_quality_not_provided=True).tolist() == [
        True, False, True, False
    ]


def test_one_minute_processing_uses_median_and_records_gaps(tmp_path: Path) -> None:
    canonical, _ = normalize_hapi_response(
        collection_id="SW_OPER_DNSAPOD_2_",
        info=_info(),
        response=_response(),
        source_file=tmp_path / "raw.json",
        source_url="https://vires.services/hapi/data?dataset=SW_OPER_DNSAPOD_2_",
        checksum_sha256="b" * 64,
    )
    processed = resample_one_minute(canonical)
    assert len(processed) == 2
    assert processed.loc[0, "rho_obs_kg_m3"] == pytest.approx(3e-12)
    assert processed.loc[0, "quality_flag"] == 1
    assert processed.loc[0, "quality_status"] == "anomalous"
    assert processed.loc[1, "gap_duration_s"] == pytest.approx(60.0)
    assert pd.isna(processed.loc[1, "rho_obs_kg_m3"])


def test_one_minute_processing_uses_circular_longitude_and_local_time(tmp_path: Path) -> None:
    response = _response()
    response["data"][0][2:5] = [179.0, 450_000, 23.9]  # type: ignore[index]
    response["data"][1][2:5] = [-179.0, 450_000, 0.1]  # type: ignore[index]
    frame, _ = normalize_hapi_response(
        collection_id="SW_OPER_DNSAPOD_2_",
        info=_info(),
        response=response,
        source_file=tmp_path / "raw.json",
        source_url="https://vires.services/hapi/data?dataset=SW_OPER_DNSAPOD_2_",
        checksum_sha256="c" * 64,
    )
    processed = resample_one_minute(frame)
    assert abs(abs(processed.loc[0, "longitude_deg"]) - 180.0) < 1e-9
    assert processed.loc[0, "local_solar_time_h"] == pytest.approx(0.0, abs=1e-9)


def test_grace_fo_2_is_explicitly_unavailable() -> None:
    with pytest.raises(ValueError, match="no official density coverage"):
        collection_for("GF_OPER_DNS2ACC_2_")


class _FakeHapiClient:
    def info(self, collection_id: str):
        payload = json.dumps(_info()).encode()
        return f"https://vires.services/hapi/info?dataset={collection_id}", payload, _info()

    def data(self, collection_id, start, stop, parameter_names):
        payload = json.dumps(_response()).encode()
        return (
            f"https://vires.services/hapi/data?dataset={collection_id}",
            payload,
            _response(),
        )


def test_ingestion_is_restartable_and_manifest_is_upserted(tmp_path: Path) -> None:
    kwargs = {
        "collection_id": "SW_OPER_DNSAPOD_2_",
        "start": "2022-02-03T00:00:00Z",
        "stop": "2022-02-03T00:03:00Z",
        "data_root": tmp_path,
        "client": _FakeHapiClient(),
        "chunk_days": 1,
    }
    first = ingest_collection(**kwargs)
    second = ingest_collection(**kwargs)
    assert first[0].row_count_raw == 3
    assert first[0].row_count_processed == 2
    assert second[0].skipped_existing is True
    assert Path(first[0].raw_file).read_bytes() == json.dumps(_response()).encode()
    assert first[0].checksum_sha256[:12] in Path(first[0].raw_file).name
    manifest = load_manifest(tmp_path / "processed/thermosphere/manifest.v1.json")
    assert len(manifest["entries"]) == 1
    assert manifest["entries"][0]["checksum_sha256"] == first[0].checksum_sha256
    assert len(list(tmp_path.rglob("*.parquet"))) == 1


class _ChangedHapiClient(_FakeHapiClient):
    def data(self, collection_id, start, stop, parameter_names):
        changed = _response()
        changed["data"][0][5] = 8e-12  # type: ignore[index]
        payload = json.dumps(changed).encode()
        return f"https://vires.services/hapi/data?dataset={collection_id}", payload, changed


def test_ingestion_rejects_silent_official_source_revision(tmp_path: Path) -> None:
    kwargs = {
        "collection_id": "SW_OPER_DNSAPOD_2_",
        "start": "2022-02-03T00:00:00Z",
        "stop": "2022-02-03T00:03:00Z",
        "data_root": tmp_path,
        "chunk_days": 1,
    }
    ingest_collection(**kwargs, client=_FakeHapiClient())
    with pytest.raises(ValueError, match="official source bytes changed"):
        ingest_collection(**kwargs, client=_ChangedHapiClient())

import math

from scripts.backfill_goes_ncei import (
    PRODUCT_PATHS,
    compute_h_magnitude,
    find_time_data_array,
    map_ncei_quality_flag,
    refresh_last_timestamp_from_partitions,
    update_last_timestamp_ingested,
)


def test_compute_h_magnitude_matches_component_norm():
    assert compute_h_magnitude(3.0, 4.0, 12.0) == 13.0


def test_compute_h_magnitude_sample_tolerance():
    samples = [
        (1.25, -2.5, 3.75),
        (0.0, 0.0, 0.01),
        (-125.4, 83.2, 9.9),
    ]

    for hn, hp, he in samples:
        expected = math.sqrt(hn * hn + hp * hp + he * he)
        assert abs(compute_h_magnitude(hn, hp, he) - expected) <= 0.01


def test_quality_mapping_uses_ncei_flag_semantics():
    assert map_ncei_quality_flag(0) == 0
    assert map_ncei_quality_flag("1") == 1
    assert map_ncei_quality_flag(2) == 2
    assert map_ncei_quality_flag(4) == 4
    assert map_ncei_quality_flag(None) == 4
    assert map_ncei_quality_flag(float("nan")) == 4


def test_goes_ncei_backfill_includes_xrs_product():
    assert PRODUCT_PATHS["xrs"] == "xrsf-l2-avg1m"


def test_legacy_l2_science_timestamp_is_accepted():
    marker = object()

    assert find_time_data_array({"L2_SciData_TimeStamp": marker}) is marker


def test_checkpoint_last_timestamp_never_regresses():
    checkpoint = {"last_timestamp_ingested": "2026-05-18T23:59:00Z"}

    update_last_timestamp_ingested(checkpoint, "2025-05-16T23:59:00Z")

    assert checkpoint["last_timestamp_ingested"] == "2026-05-18T23:59:00Z"


def test_checkpoint_last_timestamp_refreshes_from_partitions():
    checkpoint = {
        "last_timestamp_ingested": "2025-05-16T23:59:00Z",
        "partitions": {
            "source=goes_nccei/spacecraft=GOES-18/year=2026/month=05": {
                "last_timestamp_utc": "2026-05-18T23:59:00Z",
            }
        },
    }

    refresh_last_timestamp_from_partitions(checkpoint)

    assert checkpoint["last_timestamp_ingested"] == "2026-05-18T23:59:00Z"

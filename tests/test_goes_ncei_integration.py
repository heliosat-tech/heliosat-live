from datetime import date
from pathlib import Path

import pytest

from scripts.backfill_goes_ncei import (
    NceiFile,
    PRODUCT_PATHS,
    download_file,
    normalize_file,
)

PROJECT_DOWNLOAD_CACHE = Path(".cache/goes_ncei/downloads")


@pytest.mark.slow
def test_goes18_mag_single_day_download_and_normalize(tmp_path):
    item = NceiFile(
        spacecraft="GOES-18",
        product="mag",
        product_path=PRODUCT_PATHS["mag"],
        day=date(2024, 5, 1),
        url=(
            "https://data.ngdc.noaa.gov/platforms/solar-space-observing-satellites/goes/"
            "goes18/l2/data/magn-l2-avg1m/2024/05/"
            "dn_magn-l2-avg1m_g18_d20240501_v2-0-2.nc"
        ),
        file_name="dn_magn-l2-avg1m_g18_d20240501_v2-0-2.nc",
    )
    cached_file = (
        PROJECT_DOWNLOAD_CACHE
        / "goes18"
        / PRODUCT_PATHS["mag"]
        / "2024"
        / "05"
        / item.file_name
    )
    download_dir = PROJECT_DOWNLOAD_CACHE if cached_file.exists() else tmp_path / "downloads"

    local_path = download_file(item, download_dir)
    frame = normalize_file(
        local_path,
        item,
        variables={"goes_mag_hn", "goes_mag_hp", "goes_mag_he", "goes_mag_h_magnitude"},
    )
    magnitude = frame[frame["variable"] == "goes_mag_h_magnitude"]

    assert len(magnitude) >= 1440 * 0.95
    assert frame["quality_flag"].isin([0, 1, 2, 4]).all()

    pivot = frame.pivot_table(
        index="timestamp_utc",
        columns="variable",
        values="value",
        aggfunc="first",
    ).dropna()
    sample = pivot.head(100)
    expected = (
        sample["goes_mag_hn"] ** 2
        + sample["goes_mag_hp"] ** 2
        + sample["goes_mag_he"] ** 2
    ) ** 0.5

    assert (expected - sample["goes_mag_h_magnitude"]).abs().max() <= 0.01

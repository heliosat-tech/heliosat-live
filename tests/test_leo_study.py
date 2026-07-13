from __future__ import annotations

from pathlib import Path

import pytest

from leo_drag.study import run_pilot_study


def test_study_refuses_to_overwrite_existing_run_by_default(tmp_path: Path) -> None:
    run = tmp_path / "existing-run"
    run.mkdir()
    (run / "scientific-artifact.json").write_text("{}", encoding="utf-8")
    with pytest.raises(FileExistsError, match="choose a new --run-id"):
        run_pilot_study(
            data_root=tmp_path / "data",
            model_root=tmp_path,
            run_id="existing-run",
        )

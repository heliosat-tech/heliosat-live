from training.metrics import regression_metrics


def test_regression_metrics_reports_core_values():
    metrics = regression_metrics([1, 2, 3], [1, 2, 4], persistence_rmse=2.0)

    assert round(metrics["rmse"], 6) == round((1 / 3) ** 0.5, 6)
    assert metrics["mae"] == 1 / 3
    assert metrics["bias"] == 1 / 3
    assert metrics["skill_vs_persistence"] > 0
    assert metrics["peak_error"] == 1


def test_regression_metrics_handles_empty_input():
    metrics = regression_metrics([], [])

    assert metrics["rmse"] is None
    assert metrics["skill_vs_persistence"] is None


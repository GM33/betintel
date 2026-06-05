"""
predict_runs.py — BetIntel Run Prediction Model
June 5 upgrade: momentum delta layer added to run mean calculation.
See compute_edges.py for full momentum weight constant and tanh scaling.
"""

import numpy as np
import joblib
import logging
from pathlib import Path

log = logging.getLogger("betintel.models.predict_runs")

MODEL_PATH = Path(__file__).parent / "artifacts" / "run_model.pkl"
MOMENTUM_WEIGHT = 0.12

def load_model():
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Run model artifact not found at {MODEL_PATH}")
    return joblib.load(MODEL_PATH)

def predict_run_mean(features: dict, momentum_delta: float = 0.0) -> float:
    """
    Predicts expected runs for one team side.

    Args:
        features: dict of model input features (era, fip, wrc_plus, ballpark_factor, etc.)
        momentum_delta: last-5-game run differential (positive = team outscoring opponents)

    Returns:
        Adjusted expected run mean (float)
    """
    model = load_model()
    feature_vec = _build_feature_vector(features)
    base_mean = float(model.predict([feature_vec])[0])

    # ── Momentum Delta Adjustment (June 5) ────────────────────────────────────
    # tanh scaling keeps the adjustment bounded: max ~+/-12% at extreme momentum
    momentum_adj = MOMENTUM_WEIGHT * np.tanh(momentum_delta / 5.0)
    adjusted_mean = base_mean * (1 + momentum_adj)
    log.debug(f"predict_run_mean: base={base_mean:.3f} momentum_delta={momentum_delta:.2f} adj={momentum_adj:.4f} final={adjusted_mean:.3f}")

    return adjusted_mean

def predict_run_mean_to_win_prob(mu_home: float, mu_away: float, gamma: float = 1.86) -> tuple[float, float]:
    """
    Converts run means to win probabilities using gamma-power model.
    Returns (p_home, p_away).
    """
    p_home = mu_home**gamma / (mu_home**gamma + mu_away**gamma)
    p_away = 1 - p_home
    return round(float(p_home), 4), round(float(p_away), 4)

def _build_feature_vector(features: dict) -> list:
    """
    Converts raw feature dict to ordered vector matching model training schema.
    Expected keys: era, fip, xfip, wrc_plus, ops_plus, ballpark_factor,
                   bp_ip_last_3d, days_rest, home_flag
    """
    return [
        features.get("era",             4.50),
        features.get("fip",             4.30),
        features.get("xfip",            4.20),
        features.get("wrc_plus",        100.0),
        features.get("ops_plus",        100.0),
        features.get("ballpark_factor", 1.00),
        features.get("bp_ip_last_3d",   0.0),
        features.get("days_rest",        4.0),
        float(features.get("home_flag",  0)),
    ]

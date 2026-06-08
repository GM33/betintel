#!/usr/bin/env python3
"""
BetIntel Calibration Updater
Runs after each day's results are logged.
Reads all files in data/results/, recomputes rolling metrics,
and writes updated calibration_state.json.
"""
import json
import os
from pathlib import Path
from datetime import datetime, timedelta

RESULTS_DIR = Path(__file__).parent.parent / "results"
CALIB_FILE  = Path(__file__).parent / "calibration_state.json"
ROLLING_DAYS = 8


def load_results(days: int = ROLLING_DAYS) -> list[dict]:
    cutoff = datetime.utcnow().date() - timedelta(days=days)
    sessions = []
    for f in sorted(RESULTS_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            session_date = datetime.strptime(data["date"], "%Y-%m-%d").date()
            if session_date >= cutoff:
                sessions.append(data)
        except Exception as e:
            print(f"[WARN] Could not parse {f.name}: {e}")
    return sessions


def compute_rolling(sessions: list[dict]) -> dict:
    total_picks = total_wins = total_losses = 0
    total_units = 0.0
    rule_wins  = {}
    rule_total = {}

    for s in sessions:
        sm = s.get("summary", {})
        w  = sm.get("candidate_wins", 0)
        l  = sm.get("candidate_losses", 0)
        u  = sm.get("units_net", 0.0)
        total_picks  += w + l
        total_wins   += w
        total_losses += l
        total_units  += u

        for pick in s.get("picks", []):
            for rule in pick.get("rules_fired", []):
                rule_total[rule] = rule_total.get(rule, 0) + 1
                if pick.get("result") == "WIN":
                    rule_wins[rule] = rule_wins.get(rule, 0) + 1

    rolling_wr = total_wins / total_picks if total_picks else 0
    avg_units  = total_units / len(sessions) if sessions else 0
    rule_perf  = {r: round(rule_wins.get(r, 0) / rule_total[r], 3) for r in rule_total}

    return {
        "rolling_candidate_wr":  round(rolling_wr, 3),
        "rolling_units_per_day": round(avg_units, 2),
        "total_candidate_picks": total_picks,
        "total_wins":            total_wins,
        "total_losses":          total_losses,
        "total_units_net":       round(total_units, 2),
        "rule_win_rates":        rule_perf,
    }


def suggest_adjustments(rolling: dict, current: dict) -> dict:
    adj = dict(current.get("calibration_adjustments", {}))
    wr  = rolling["rolling_candidate_wr"]

    if wr < 0.70:
        adj["confidence_floor"] = min(adj.get("confidence_floor", 0.60) + 0.02, 0.70)
        print(f"[CAL] WR {wr:.1%} < 70% — raising confidence_floor to {adj['confidence_floor']:.2f}")
    elif wr > 0.90:
        adj["confidence_floor"] = max(adj.get("confidence_floor", 0.60) - 0.01, 0.55)
        print(f"[CAL] WR {wr:.1%} > 90% — relaxing confidence_floor to {adj['confidence_floor']:.2f}")

    return adj


def main():
    print("[CAL] Loading results...")
    sessions = load_results()
    if not sessions:
        print("[CAL] No results found — nothing to calibrate.")
        return

    print(f"[CAL] {len(sessions)} sessions in rolling window")
    rolling = compute_rolling(sessions)
    current = json.loads(CALIB_FILE.read_text()) if CALIB_FILE.exists() else {}
    adj     = suggest_adjustments(rolling, current)

    state = {
        "last_updated":             datetime.utcnow().strftime("%Y-%m-%d"),
        "model_version":            current.get("model_version", "v2.4"),
        "rolling_window_days":      ROLLING_DAYS,
        "sessions":                 current.get("sessions", []),
        **rolling,
        "calibration_adjustments":  adj,
        "signals":                  current.get("signals", {}),
        "next_calibration_trigger": (datetime.utcnow() + timedelta(days=1)).strftime("%Y-%m-%d"),
        "notes":                    current.get("notes", ""),
    }

    CALIB_FILE.write_text(json.dumps(state, indent=2))
    print(f"[CAL] Done. Rolling WR: {rolling['rolling_candidate_wr']:.1%} | Net: {rolling['total_units_net']}u")


if __name__ == "__main__":
    main()

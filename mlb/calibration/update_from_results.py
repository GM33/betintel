"""
BetIntel Calibration Updater
Ingests pick_results JSON files and adjusts edge-tier weights
based on empirical win rates vs predicted win rates.

Edge tiers: strong_bet, value_bet, marginal_bet, no_edge
Formula: edge = model_win_prob - pinnacle_no_vig_prob

Usage:
    python mlb/calibration/update_from_results.py --results mlb/seed/pick_results_2026_06_04.json
    python mlb/calibration/update_from_results.py --all   # ingests all files in mlb/seed/
"""

import json
import os
import glob
import argparse
from datetime import datetime
from collections import defaultdict

# ── Current tier thresholds (model_prob - pinnacle_no_vig_prob) ──
EDGE_TIERS = {
    "strong_bet":   {"min_edge": 0.06, "weight": 1.0},
    "value_bet":    {"min_edge": 0.03, "weight": 0.75},
    "marginal_bet": {"min_edge": 0.01, "weight": 0.50},
    "no_edge":      {"min_edge": 0.00, "weight": 0.0},
}

CALIBRATION_FILE = os.path.join(os.path.dirname(__file__), "calibration_state.json")


def load_calibration_state():
    if os.path.exists(CALIBRATION_FILE):
        with open(CALIBRATION_FILE) as f:
            return json.load(f)
    return {
        "last_updated": None,
        "total_picks": 0,
        "total_wins": 0,
        "by_tier": {
            "strong_bet":   {"picks": 0, "wins": 0, "win_rate": 0.0},
            "value_bet":    {"picks": 0, "wins": 0, "win_rate": 0.0},
            "marginal_bet": {"picks": 0, "wins": 0, "win_rate": 0.0},
        },
        "by_sport": {},
        "by_bet_type": {},
        "recommended_weight_adjustments": {},
    }


def save_calibration_state(state):
    os.makedirs(os.path.dirname(CALIBRATION_FILE), exist_ok=True)
    with open(CALIBRATION_FILE, "w") as f:
        json.dump(state, f, indent=2)
    print(f"[✓] Calibration state saved → {CALIBRATION_FILE}")


def ingest_results(results: list, state: dict) -> dict:
    """Fold new results into calibration state."""
    for pick in results:
        tier = pick.get("edge_tier", "no_edge")
        sport = pick.get("sport", "unknown")
        bet_type = pick.get("bet_type", "unknown")
        won = pick.get("result", "").lower() == "won"

        # ── Overall ──
        state["total_picks"] += 1
        if won:
            state["total_wins"] += 1

        # ── By tier ──
        if tier in state["by_tier"]:
            state["by_tier"][tier]["picks"] += 1
            if won:
                state["by_tier"][tier]["wins"] += 1
            picks = state["by_tier"][tier]["picks"]
            wins  = state["by_tier"][tier]["wins"]
            state["by_tier"][tier]["win_rate"] = round(wins / picks, 4) if picks else 0.0

        # ── By sport ──
        if sport not in state["by_sport"]:
            state["by_sport"][sport] = {"picks": 0, "wins": 0, "win_rate": 0.0}
        state["by_sport"][sport]["picks"] += 1
        if won:
            state["by_sport"][sport]["wins"] += 1
        sp = state["by_sport"][sport]
        sp["win_rate"] = round(sp["wins"] / sp["picks"], 4) if sp["picks"] else 0.0

        # ── By bet type ──
        if bet_type not in state["by_bet_type"]:
            state["by_bet_type"][bet_type] = {"picks": 0, "wins": 0, "win_rate": 0.0}
        state["by_bet_type"][bet_type]["picks"] += 1
        if won:
            state["by_bet_type"][bet_type]["wins"] += 1
        bt = state["by_bet_type"][bet_type]
        bt["win_rate"] = round(bt["wins"] / bt["picks"], 4) if bt["picks"] else 0.0

    state["last_updated"] = datetime.utcnow().isoformat()
    return state


def compute_weight_adjustments(state: dict) -> dict:
    """
    Compare empirical win rate per tier against baseline expected rates.
    If strong_bet is winning < 55% → reduce weight signal.
    If marginal_bet is winning > 52% → promote weight.
    Returns recommended delta adjustments.
    """
    BASELINES = {
        "strong_bet":   0.60,
        "value_bet":    0.54,
        "marginal_bet": 0.51,
    }
    adjustments = {}
    for tier, baseline in BASELINES.items():
        tier_data = state["by_tier"].get(tier, {})
        picks = tier_data.get("picks", 0)
        if picks < 10:
            adjustments[tier] = {"status": "insufficient_sample", "picks": picks}
            continue
        actual = tier_data.get("win_rate", 0.0)
        delta = round(actual - baseline, 4)
        adjustments[tier] = {
            "baseline_win_rate": baseline,
            "actual_win_rate": actual,
            "delta": delta,
            "recommendation": (
                "increase_weight" if delta > 0.03
                else "decrease_weight" if delta < -0.03
                else "hold"
            ),
        }
    return adjustments


def print_summary(state: dict):
    total = state["total_picks"]
    wins  = state["total_wins"]
    rate  = round(wins / total * 100, 1) if total else 0
    print(f"\n{'='*50}")
    print(f"  BetIntel Calibration Summary — {state['last_updated'][:10]}")
    print(f"{'='*50}")
    print(f"  Overall: {wins}/{total} ({rate}%)")
    print()
    print("  By Tier:")
    for tier, d in state["by_tier"].items():
        p, w = d['picks'], d['wins']
        wr = round(w/p*100,1) if p else 0
        print(f"    {tier:<16} {w}/{p} ({wr}%)")
    print()
    print("  By Sport:")
    for sport, d in state["by_sport"].items():
        p, w = d['picks'], d['wins']
        wr = round(w/p*100,1) if p else 0
        print(f"    {sport:<10} {w}/{p} ({wr}%)")
    print()
    print("  By Bet Type:")
    for bt, d in state["by_bet_type"].items():
        p, w = d['picks'], d['wins']
        wr = round(w/p*100,1) if p else 0
        print(f"    {bt:<20} {w}/{p} ({wr}%)")
    print()
    adj = state.get("recommended_weight_adjustments", {})
    if adj:
        print("  Weight Adjustment Recommendations:")
        for tier, rec in adj.items():
            if "status" in rec:
                print(f"    {tier:<16} ⚠ {rec['status']} (n={rec['picks']})")
            else:
                arrow = "↑" if rec['recommendation'] == 'increase_weight' else ("↓" if rec['recommendation'] == 'decrease_weight' else "→")
                print(f"    {tier:<16} {arrow} {rec['recommendation']} | actual={rec['actual_win_rate']} vs baseline={rec['baseline_win_rate']} (Δ{rec['delta']:+.4f})")
    print(f"{'='*50}\n")


def main():
    parser = argparse.ArgumentParser(description="BetIntel Calibration Updater")
    parser.add_argument("--results", help="Path to a single results JSON file")
    parser.add_argument("--all", action="store_true", help="Ingest all files in mlb/seed/pick_results_*.json")
    args = parser.parse_args()

    state = load_calibration_state()

    if args.all:
        files = sorted(glob.glob("mlb/seed/pick_results_*.json"))
        print(f"[→] Ingesting {len(files)} result file(s)...")
        for fpath in files:
            with open(fpath) as f:
                results = json.load(f)
            print(f"    {fpath} ({len(results)} picks)")
            state = ingest_results(results, state)
    elif args.results:
        with open(args.results) as f:
            results = json.load(f)
        print(f"[→] Ingesting {args.results} ({len(results)} picks)...")
        state = ingest_results(results, state)
    else:
        print("[!] No input specified. Use --results <file> or --all")
        return

    state["recommended_weight_adjustments"] = compute_weight_adjustments(state)
    save_calibration_state(state)
    print_summary(state)


if __name__ == "__main__":
    main()

"""
sgp_guard.py — BetIntel SGP Correlation Guard (June 5 upgrade)

Blocks same-game correlated legs from appearing together in a parlay
without an explicit override flag.

June 3 post-mortem addition:
- HIGH_VARIANCE flag on either leg now blocks parlay inclusion entirely
  (extra-innings / coin-flip total games should never be in a multi-leg)
"""

import logging
from itertools import combinations

log = logging.getLogger("betintel.models.sgp_guard")

CORRELATED_PAIRS = [
    ("k_strikeouts", "h2h"),
    ("k_strikeouts", "spreads"),
    ("k_strikeouts", "totals"),
    ("h2h",          "spreads"),
    ("player_hits",  "totals"),
    ("player_tb",    "totals"),
]

NEGATIVE_CORR_PAIRS = [
    ("h2h",     "totals"),
    ("spreads", "totals"),
]


def check_parlay_for_sgp_conflicts(legs: list[dict]) -> list[dict]:
    """
    Accepts a list of parlay legs and returns conflict dicts.
    Each leg dict may include: game_id, market_type, side, player_id, high_variance (bool).
    """
    conflicts = []

    for (i, leg_a), (j, leg_b) in combinations(enumerate(legs), 2):

        # ── HIGH_VARIANCE parlay block (June 3 post-mortem) ──────────────────
        for idx, leg in [(i, leg_a), (j, leg_b)]:
            if leg.get("high_variance"):
                conflicts.append({
                    "leg_a": idx, "leg_b": None,
                    "conflict_type": "HIGH_VARIANCE_BLOCK",
                    "message": (
                        f"⛔ Leg {idx+1} is tagged HIGH_VARIANCE (model total within 0.5 runs of market line). "
                        "This leg must not appear in any parlay — too much coin-flip variance."
                    ),
                    "block": True,
                })

        if leg_a.get("game_id") != leg_b.get("game_id"):
            continue

        mt_a  = leg_a.get("market_type", "")
        mt_b  = leg_b.get("market_type", "")
        pair  = (mt_a, mt_b)
        pair_r = (mt_b, mt_a)

        if mt_a == mt_b:
            conflicts.append({
                "leg_a": i, "leg_b": j,
                "conflict_type": "SAME_GAME_DUPLICATE",
                "message": f"Legs {i+1} and {j+1} are the same market ({mt_a}) on the same game — remove one.",
                "block": True,
            })
            continue

        if pair in NEGATIVE_CORR_PAIRS or pair_r in NEGATIVE_CORR_PAIRS:
            conflicts.append({
                "leg_a": i, "leg_b": j,
                "conflict_type": "NEGATIVE_CORR",
                "message": (
                    f"⚠️ Legs {i+1} ({mt_a}) and {j+1} ({mt_b}) are negatively correlated on the same game. "
                    "Do NOT combine in a parlay."
                ),
                "block": True,
            })
        elif pair in CORRELATED_PAIRS or pair_r in CORRELATED_PAIRS:
            conflicts.append({
                "leg_a": i, "leg_b": j,
                "conflict_type": "POSITIVE_CORR",
                "message": (
                    f"⚠️ Legs {i+1} ({mt_a}) and {j+1} ({mt_b}) are positively correlated on the same game. "
                    "Combine only if your book allows SGP and you accept the risk."
                ),
                "block": False,
            })

    # Deduplicate HIGH_VARIANCE blocks (same leg may be checked twice)
    seen = set()
    deduped = []
    for c in conflicts:
        key = (c["conflict_type"], c["leg_a"], c["leg_b"])
        if key not in seen:
            seen.add(key)
            deduped.append(c)

    if deduped:
        block_count = sum(1 for c in deduped if c["block"])
        log.warning(f"SGP guard: {len(deduped)} conflict(s), {block_count} blocking.")
    else:
        log.info("SGP guard: clean.")

    return deduped


def get_sgp_summary(legs: list[dict]) -> dict:
    conflicts = check_parlay_for_sgp_conflicts(legs)
    return {
        "safe":        len(conflicts) == 0,
        "block_count": sum(1 for c in conflicts if c["block"]),
        "warn_count":  sum(1 for c in conflicts if not c["block"]),
        "conflicts":   conflicts,
    }

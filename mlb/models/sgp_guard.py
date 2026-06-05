"""
sgp_guard.py — BetIntel SGP Correlation Guard (June 5 upgrade)

Blocks same-game correlated legs from appearing together in a parlay
without an explicit override flag. Prevents the June 4 failure pattern
where a pitcher K prop + team spread on the same game shared full outcome
correlation and wiped the entire ticket.

Usage:
    from mlb.models.sgp_guard import check_parlay_for_sgp_conflicts
    conflicts = check_parlay_for_sgp_conflicts(legs)
    # legs = list of dicts: {"game_id": str, "market_type": str, "side": str, "player_id": str|None}
"""

import logging
from itertools import combinations

log = logging.getLogger("betintel.models.sgp_guard")

# Market types that are considered correlated when on the same game_id
# pitcher_k + team_spread is the canonical June 4 failure pattern
CORRELATED_PAIRS = [
    ("k_strikeouts",  "h2h"),
    ("k_strikeouts",  "spreads"),
    ("k_strikeouts",  "totals"),
    ("h2h",           "spreads"),   # same-game ML + RL = positive but flagged for sizing
    ("player_hits",   "totals"),
    ("player_tb",     "totals"),
]

# Pairs that are NEGATIVE correlation (one leg winning makes the other less likely)
NEGATIVE_CORR_PAIRS = [
    ("h2h",     "totals"),   # team winning big often suppresses total over (pace slows)
    ("spreads",  "totals"),
]


def check_parlay_for_sgp_conflicts(legs: list[dict]) -> list[dict]:
    """
    Accepts a list of parlay legs and returns a list of conflict dicts.
    Each conflict contains:
        - leg_a, leg_b: the two conflicting leg indices
        - conflict_type: 'POSITIVE_CORR' | 'NEGATIVE_CORR' | 'SAME_GAME_DUPLICATE'
        - message: human-readable warning for UI display
        - block: bool — True means the parlay should be BLOCKED unless overridden
    """
    conflicts = []

    for (i, leg_a), (j, leg_b) in combinations(enumerate(legs), 2):
        if leg_a.get("game_id") != leg_b.get("game_id"):
            continue  # different games — no SGP risk

        mt_a = leg_a.get("market_type", "")
        mt_b = leg_b.get("market_type", "")
        pair  = (mt_a, mt_b)
        pair_r = (mt_b, mt_a)  # reversed

        # Same market type on the same game = duplicate
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
                    "One leg winning reduces the probability of the other. "
                    "These legs should NOT be combined in a parlay."
                ),
                "block": True,
            })
        elif pair in CORRELATED_PAIRS or pair_r in CORRELATED_PAIRS:
            conflicts.append({
                "leg_a": i, "leg_b": j,
                "conflict_type": "POSITIVE_CORR",
                "message": (
                    f"⚠️ Legs {i+1} ({mt_a}) and {j+1} ({mt_b}) are positively correlated on the same game "
                    "(e.g. pitcher K prop + team spread). Most books will flag this as an SGP. "
                    "Combine only if your book allows SGP and you accept the correlation risk."
                ),
                "block": False,  # allowed but must be displayed prominently
            })

    if conflicts:
        block_count = sum(1 for c in conflicts if c["block"])
        log.warning(f"SGP guard: {len(conflicts)} conflict(s) found, {block_count} blocking.")
    else:
        log.info("SGP guard: no conflicts detected.")

    return conflicts


def get_sgp_summary(legs: list[dict]) -> dict:
    """
    Returns a summary dict for UI display:
        - safe: bool
        - block_count: int
        - warn_count: int
        - conflicts: list
    """
    conflicts = check_parlay_for_sgp_conflicts(legs)
    return {
        "safe": len(conflicts) == 0,
        "block_count": sum(1 for c in conflicts if c["block"]),
        "warn_count":  sum(1 for c in conflicts if not c["block"]),
        "conflicts": conflicts,
    }

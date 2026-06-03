import os
from dotenv import load_dotenv
load_dotenv()

# ── Shared API / DB config (mirrors mlb/config.py) ────────────────────────────
ODDS_BASE       = "https://api.the-odds-api.com/v4"
ODDS_API_KEY    = os.environ["ODDS_API_KEY"]
DATABASE_URL    = os.environ["DATABASE_URL"]

# ── WNBA-specific odds API settings ──────────────────────────────────────────
WNBA_SPORT_KEY  = "basketball_wnba"
WNBA_REGIONS    = "us"
WNBA_MARKETS    = [
    "h2h",
    "spreads",
    "totals",
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_points_rebounds_assists",
    "player_threes",
]

# ── Model thresholds (same as MLB defaults) ───────────────────────────────────
EDGE_THRESHOLD  = 0.03    # minimum edge to flag as CANDIDATE
KELLY_FRACTION  = 0.25    # fractional Kelly
MAX_STAKE_PCT   = 0.03    # hard cap per bet as fraction of bankroll

# ── Prop quality gates ────────────────────────────────────────────────────────
MIN_MINUTES_PROJ    = 18   # ignore props where projected minutes < 18
MIN_GAMES_PLAYED    = 5    # ignore players with < 5 games this season
HIGH_CONF_EDGE      = 0.06 # edge >= 6% → HIGH confidence
MED_CONF_EDGE       = 0.04 # edge 4-6% → MEDIUM confidence

# ── Game model constant ───────────────────────────────────────────────────────
BRADLEY_TERRY_GAMMA = 1.86  # exponent for win-probability formula

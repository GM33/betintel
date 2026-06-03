import os
from dotenv import load_dotenv
load_dotenv()

MLB_BASE = "https://statsapi.mlb.com/api/v1"
ODDS_BASE = "https://api.the-odds-api.com/v4"
ODDS_API_KEY    = os.environ.get("ODDS_API_KEY")
DATABASE_URL    = os.environ.get("DATABASE_URL")
OPENAI_API_KEY  = os.environ.get("OPENAI_API_KEY")
WEATHER_API_KEY = os.environ.get("WEATHER_API_KEY")
EDGE_THRESHOLD  = 0.03
KELLY_FRACTION  = 0.25
MAX_STAKE_PCT   = 0.03

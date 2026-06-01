"""
BetIntel Configuration File
Centralized settings and API key management.
Copy this file to config_local.py and fill in your actual values.
Never commit config_local.py to version control.
"""

import os

# ──────────────────────────────────────────────
# API Keys — load from environment variables
# ──────────────────────────────────────────────

API_KEYS = {
    # Odds / Sportsbook APIs
    "THE_ODDS_API":       os.getenv("THE_ODDS_API_KEY", "YOUR_ODDS_API_KEY_HERE"),
    "SPORTRADAR":         os.getenv("SPORTRADAR_API_KEY", "YOUR_SPORTRADAR_KEY_HERE"),
    "BETFAIR":            os.getenv("BETFAIR_API_KEY", "YOUR_BETFAIR_KEY_HERE"),

    # Stats / Data APIs
    "SPORTSDATA_IO":      os.getenv("SPORTSDATA_IO_KEY", "YOUR_SPORTSDATA_KEY_HERE"),
    "BASEBALL_REFERENCE": os.getenv("BASEBALL_REF_KEY", ""),    # Add if needed
    "NBA_API":            os.getenv("NBA_API_KEY", ""),          # Add if needed

    # Notifications
    "TELEGRAM_BOT_TOKEN": os.getenv("TELEGRAM_BOT_TOKEN", ""),
    "DISCORD_WEBHOOK":    os.getenv("DISCORD_WEBHOOK_URL", ""),
}

# ──────────────────────────────────────────────
# Sports Settings
# ──────────────────────────────────────────────

SPORTS = {
    "enabled": ["baseball_mlb", "basketball_nba"],
    "markets": ["h2h", "spreads", "totals"],   # Bet types to track
    "regions": ["us"],                          # Market regions (us, uk, eu, au)
}

# ──────────────────────────────────────────────
# Database Settings
# ──────────────────────────────────────────────

DATABASE = {
    "engine": "sqlite",               # Options: sqlite | postgresql | mysql
    "name":   os.getenv("DB_NAME", "betintel.db"),
    "host":   os.getenv("DB_HOST", "localhost"),
    "port":   int(os.getenv("DB_PORT", 5432)),
    "user":   os.getenv("DB_USER", ""),
    "password": os.getenv("DB_PASSWORD", ""),
}

# ──────────────────────────────────────────────
# App Settings
# ──────────────────────────────────────────────

APP = {
    "debug":          os.getenv("DEBUG", "false").lower() == "true",
    "log_level":      os.getenv("LOG_LEVEL", "INFO"),     # DEBUG | INFO | WARNING | ERROR
    "timezone":       "America/Chicago",                   # Laredo, TX timezone
    "refresh_interval_minutes": 10,                        # How often to poll new odds
    "value_threshold": 0.05,                               # Min edge % to flag a bet (5%)
    "bankroll":       float(os.getenv("BANKROLL", 1000)), # Starting bankroll in USD
    "max_bet_pct":    0.05,                                # Max 5% of bankroll per bet
}

# ──────────────────────────────────────────────
# Output / Reporting Settings
# ──────────────────────────────────────────────

REPORTING = {
    "output_dir":   "./reports",
    "export_csv":   True,
    "export_json":  True,
    "notify_telegram": False,
    "notify_discord":  False,
}

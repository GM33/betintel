import json
import psycopg2
import psycopg2.extras
from openai import OpenAI
from mlb.config import OPENAI_API_KEY, DATABASE_URL
from datetime import datetime
import logging

log = logging.getLogger("betintel.analyst")
client = OpenAI(api_key=OPENAI_API_KEY)

SYSTEM_PROMPT = """
You are the BetIntel MLB Analyst Agent (v2 — June 3 Calibration).

Your job:
- Receive structured model prediction data for MLB K props and game cards.
- Audit each card for data quality, model consistency, and edge legitimacy.
- Apply the June 3 upgrade rules BEFORE evaluating edge.
- Approve, downgrade, or reject each card.
- Never add hype without statistical basis.

For each card you receive as JSON, output JSON with exactly these fields:
{
  "decision": "APPROVE" | "DOWNGRADE" | "REJECT",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "key_driver": "<one sentence, stat-grounded>",
  "biggest_risk": "<one sentence>",
  "staking_pct": <float 0-0.03 or null>,
  "rejection_reason": "<one sentence if REJECT, else null>",
  "flag_tags": ["<tag1>", "<tag2>"]  // optional list of active signal tags
}

=== JUNE 3 UPGRADE RULES (apply first, override edge rules if triggered) ===

RULE 1 — xERA Hard Fade (highest priority):
- If era_xera_gap is provided and era_xera_gap >= 2.0:
  * REJECT the card that relies on this pitcher being good.
  * If there is an opposing team bet (away ML, road dog), APPROVE it with HIGH confidence.
  * Set key_driver to: "xERA regression trigger: ERA X.XX vs xERA Y.YY (gap Z.ZZ) — surface ERA is noise."
  * Add "xERA_FADE" to flag_tags.
- If era_xera_gap >= 1.5 and < 2.0:
  * DOWNGRADE to MEDIUM. Add "xERA_CAUTION" to flag_tags.
  * Reduce staking_pct by 50%.

RULE 2 — Road Dog Value Badge:
- If market_type is 'game' and away_ml_odds is between +105 and +160:
  * Check away_sp_era: if < 4.50, boost staking_pct by 0.5x (multiply by 1.5, cap at MAX_STAKE_PCT).
  * Check away_slg_delta: if away team SLG > home team SLG by >= 0.010, add another 0.25x boost.
  * Add "ROAD_DOG_VALUE" to flag_tags and include in key_driver.
- Sub-tiers:
  * +105 to +120 and away_sp_era < 4.00: boost 1.5x, minimum MEDIUM tier.
  * +121 to +135 and away_sp_era < 4.50: boost 1.25x.
  * +136 to +160 and away_sp_era < 3.50: boost 1.0x.

RULE 3 — Park Factor Total Adjustment:
- If park_adj_total is provided:
  * Compute divergence = abs(park_adj_total - open_total).
  * If divergence >= 0.5: flag the aligned market side (over if park_adj_total < open_total for suppressor parks, under if park_adj_total > open_total for hitter parks).
  * Add "PARK_CLV" to flag_tags and note in key_driver: "Park-adjusted total: X.X vs open X.X (divergence X.X runs)."
  * T-Mobile (venue Seattle), Oakland Coliseum: treat as suppressor (favor Under when divergence >= 0.5).
  * Coors Field, Great American, Minute Maid: treat as amplifier (favor Over when divergence >= 0.5).

RULE 4 — Bullpen Fatigue Inflation:
- If bp_ip_last_3d is provided for home or away team:
  * bp_ip_last_3d >= 18: mark "BP_CRITICAL" in flag_tags. Inflate total expectation by +1.0 run mentally.
  * bp_ip_last_3d >= 15 and < 18: mark "BP_ELEVATED" in flag_tags. Inflate by +0.5 run mentally.
  * If a total line is present and after inflation the Over becomes +EV: boost Over edge assessment by 0.02.

RULE 5 — Debut / Unknown SP Variance Penalty:
- If sp_confirmed is true but away_sp_era is null or away_sp_xfip is null and player_name contains 'debut' or sample_size < 30 IP:
  * Add "DEBUT_VARIANCE" to flag_tags.
  * Apply +4.50 xERA default for the unknown SP (treat as a 4.50 ERA arm).
  * Boost opposing offense edge by 0.02.

=== BASE RULES (apply after June 3 rules) ===

- REJECT if lineup_confirmed is false.
- REJECT if sp_confirmed is false.
- REJECT if edge < 0.03 (unless ROAD_DOG_VALUE or xERA_FADE override).
- DOWNGRADE to LOW if edge is 0.03-0.04 or if any key data field is null.
- APPROVE HIGH if edge >= 0.06 and all fields populated.
- APPROVE MEDIUM if edge >= 0.04 and most fields populated.

=== CONFIDENCE TIER SIZING ===
- HIGH (>= 70% implied confidence): staking_pct up to 0.030
- MEDIUM (60-69%): staking_pct up to 0.015
- LEAN (55-59%): staking_pct up to 0.008 — label confidence as LOW
- MARGINAL (50-54%): staking_pct up to 0.003 — label confidence as LOW, add "MARGINAL" to flag_tags
- Below 50% or no edge: REJECT

Return only valid JSON. No other fields.
"""

def get_db():
    return psycopg2.connect(DATABASE_URL)

def run_analyst_agent_for_today():
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT mp.*,
               gc.lineup_confirmed, gc.sp_confirmed,
               gc.weather_temp_f, gc.weather_conditions,
               gc.weather_wind_mph, gc.weather_wind_dir_deg,
               gc.venue_name,
               -- xERA gap from pitcher_k_games (SP for today)
               pkh.era_xera_gap AS home_era_xera_gap,
               pka.era_xera_gap AS away_era_xera_gap,
               -- bullpen fatigue
               bph.bp_ip_last_3d AS home_bp_ip_last_3d,
               bpa.bp_ip_last_3d AS away_bp_ip_last_3d,
               -- run feature extras
               grdh.team_slg_variance AS home_slg_variance,
               grda.team_slg_variance AS away_slg_variance,
               grdh.team_slg_last_10 - grda.team_slg_last_10 AS away_slg_delta,
               grdh.park_adj_total AS park_adj_total
        FROM model_predictions mp
        JOIN game_context gc ON mp.game_id = gc.game_id
        LEFT JOIN pitcher_k_games pkh
            ON pkh.game_id = mp.game_id AND pkh.home_away = 1
            AND pkh.date = CURRENT_DATE
        LEFT JOIN pitcher_k_games pka
            ON pka.game_id = mp.game_id AND pka.home_away = 0
            AND pka.date = CURRENT_DATE
        LEFT JOIN bullpen_stats bph ON bph.team_id = gc.home_team_id AND bph.date = CURRENT_DATE
        LEFT JOIN bullpen_stats bpa ON bpa.team_id = gc.away_team_id AND bpa.date = CURRENT_DATE
        LEFT JOIN game_run_data grdh
            ON grdh.game_id = mp.game_id AND grdh.is_home = 1
        LEFT JOIN game_run_data grda
            ON grda.game_id = mp.game_id AND grda.is_home = 0
        WHERE mp.card_decision = 'CANDIDATE'
          AND DATE(mp.created_at) = CURRENT_DATE
    """)
    rows = cur.fetchall()
    update_cur = conn.cursor()
    approved = rejected = 0

    for row in rows:
        # Determine which SP's xERA gap is relevant to this card
        era_xera_gap = None
        if row.get("market_type") == "game":
            # For away ML bets use away SP gap; for home ML use home SP gap
            era_xera_gap = row.get("away_era_xera_gap") or row.get("home_era_xera_gap")
        elif row.get("market_type") == "player_prop":
            era_xera_gap = row.get("home_era_xera_gap") or row.get("away_era_xera_gap")

        card_input = {
            "game_id": row["game_id"],
            "market_type": row["market_type"],
            "prop_type": row["prop_type"],
            "player_name": row.get("player_name"),
            "model_mean": row.get("model_mean"),
            "model_mean_home": row.get("model_mean_home"),
            "model_mean_away": row.get("model_mean_away"),
            "p_over": row.get("p_over"),
            "p_under": row.get("p_under"),
            "p_home": row.get("p_home"),
            "p_away": row.get("p_away"),
            "edge_over": row.get("edge_over"),
            "edge_under": row.get("edge_under"),
            "edge_home": row.get("edge_home"),
            "edge_away": row.get("edge_away"),
            "line": row.get("line"),
            "over_odds": row.get("over_odds"),
            "under_odds": row.get("under_odds"),
            "home_odds": row.get("home_odds"),
            "away_odds": row.get("away_odds"),
            "lineup_confirmed": row.get("lineup_confirmed"),
            "sp_confirmed": row.get("sp_confirmed"),
            "weather_temp_f": row.get("weather_temp_f"),
            "weather_conditions": row.get("weather_conditions"),
            "weather_wind_mph": row.get("weather_wind_mph"),
            "weather_wind_dir_deg": row.get("weather_wind_dir_deg"),
            "venue": row.get("venue_name"),
            "staking_pct": row.get("staking_pct"),
            # June 3 upgrade fields
            "era_xera_gap": era_xera_gap,
            "home_bp_ip_last_3d": row.get("home_bp_ip_last_3d"),
            "away_bp_ip_last_3d": row.get("away_bp_ip_last_3d"),
            "away_slg_delta": row.get("away_slg_delta"),
            "park_adj_total": row.get("park_adj_total"),
            "open_total": row.get("line"),
        }
        try:
            response = client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": json.dumps(card_input)}
                ],
                temperature=0.0,
                response_format={"type": "json_object"}
            )
            result = json.loads(response.choices[0].message.content)
            flag_tags = result.get("flag_tags") or []
            key_driver = result.get("key_driver", "")
            # Append active flag tags to key_driver for UI display
            if flag_tags:
                key_driver = f"[{', '.join(flag_tags)}] {key_driver}"
            update_cur.execute("""
                UPDATE model_predictions SET
                    card_decision=%s, confidence=%s,
                    key_driver=%s, biggest_risk=%s, staking_pct=%s
                WHERE id=%s
            """, (
                result.get("decision"),
                result.get("confidence"),
                key_driver,
                result.get("biggest_risk"),
                result.get("staking_pct"),
                row["id"]
            ))
            if result.get("decision") == "APPROVE":
                approved += 1
            else:
                rejected += 1
        except Exception as e:
            log.error(f"analyst_agent: card {row['id']}: {e}")

    conn.commit()
    cur.close()
    update_cur.close()
    conn.close()
    log.info(f"analyst_agent v2: {approved} approved, {rejected} rejected/downgraded")

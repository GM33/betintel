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
You are the BetIntel MLB Analyst Agent.

Your job:
- Receive structured model prediction data for MLB K props and game cards.
- Audit each card for data quality, model consistency, and edge legitimacy.
- Approve, downgrade, or reject each card.
- Never add hype without statistical basis.

For each card you receive as JSON, output JSON with exactly these fields:
{
  "decision": "APPROVE" | "DOWNGRADE" | "REJECT",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "key_driver": "<one sentence, stat-grounded>",
  "biggest_risk": "<one sentence>",
  "staking_pct": <float 0-0.03 or null>,
  "rejection_reason": "<one sentence if REJECT, else null>"
}

Rules:
- REJECT if lineup_confirmed is false.
- REJECT if sp_confirmed is false.
- REJECT if edge < 0.03.
- DOWNGRADE to LOW if edge is 0.03-0.04 or if any key data field is null.
- APPROVE HIGH if edge >= 0.06 and all fields populated.
- APPROVE MEDIUM if edge >= 0.04 and most fields populated.
- Return only valid JSON. No other fields.
"""

def get_db():
    return psycopg2.connect(DATABASE_URL)

def run_analyst_agent_for_today():
    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT mp.*, gc.lineup_confirmed, gc.sp_confirmed,
               gc.weather_temp_f, gc.weather_conditions, gc.venue_name
        FROM model_predictions mp
        JOIN game_context gc ON mp.game_id = gc.game_id
        WHERE mp.card_decision = 'CANDIDATE'
          AND DATE(mp.created_at) = CURRENT_DATE
    """)
    rows = cur.fetchall()
    update_cur = conn.cursor()
    approved = rejected = 0

    for row in rows:
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
            "lineup_confirmed": row.get("lineup_confirmed"),
            "sp_confirmed": row.get("sp_confirmed"),
            "weather_temp_f": row.get("weather_temp_f"),
            "weather_conditions": row.get("weather_conditions"),
            "venue": row.get("venue_name"),
            "staking_pct": row.get("staking_pct")
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
            update_cur.execute("""
                UPDATE model_predictions SET
                    card_decision=%s, confidence=%s,
                    key_driver=%s, biggest_risk=%s, staking_pct=%s
                WHERE id=%s
            """, (
                result.get("decision"),
                result.get("confidence"),
                result.get("key_driver"),
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
    log.info(f"analyst_agent: {approved} approved, {rejected} rejected/downgraded")

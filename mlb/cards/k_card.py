def render_k_card(row: dict) -> dict:
    edge_over = row.get("edge_over") or 0
    edge_under = row.get("edge_under") or 0
    side = "Over" if edge_over >= edge_under else "Under"
    edge = edge_over if side == "Over" else edge_under
    odds = row.get("over_odds") if side == "Over" else row.get("under_odds")
    p_model = row.get("p_over") if side == "Over" else row.get("p_under")
    p_imp = None
    if odds:
        p_imp = round(100 / (odds + 100) if odds > 0 else -odds / (-odds + 100), 4)

    return {
        "card_type": "K_PROP",
        "game_id": row.get("game_id"),
        "pitcher": row.get("player_name"),
        "market": f"{side} {row.get('line')} Ks",
        "odds": odds,
        "implied_prob_pct": round(p_imp * 100, 1) if p_imp else None,
        "model_prob_pct": round(p_model * 100, 1) if p_model else None,
        "edge_pct": round(edge * 100, 1) if edge else None,
        "confidence": row.get("confidence"),
        "decision": row.get("card_decision"),
        "model_mean_ks": round(row.get("model_mean"), 2) if row.get("model_mean") else None,
        "key_driver": row.get("key_driver"),
        "biggest_risk": row.get("biggest_risk"),
        "staking_pct": row.get("staking_pct"),
        "venue": row.get("venue_name"),
        "expires_at": str(row.get("game_date")) if row.get("game_date") else None
    }

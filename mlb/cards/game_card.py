def render_game_card(row: dict) -> dict:
    edge_home = row.get("edge_home") or 0
    edge_away = row.get("edge_away") or 0
    edge_over = row.get("edge_over") or 0
    edge_under = row.get("edge_under") or 0

    best_side = "Home" if edge_home >= edge_away else "Away"
    edge_ml = edge_home if best_side == "Home" else edge_away
    ml_odds = row.get("home_odds") if best_side == "Home" else row.get("away_odds")
    p_ml = row.get("p_home") if best_side == "Home" else row.get("p_away")

    total_side = "Over" if edge_over >= edge_under else "Under"
    edge_tot = edge_over if total_side == "Over" else edge_under
    tot_odds = row.get("over_odds") if total_side == "Over" else row.get("under_odds")
    p_tot = row.get("p_over") if total_side == "Over" else row.get("p_under")

    return {
        "card_type": "GAME",
        "game_id": row.get("game_id"),
        "matchup": f"{row.get('away_team', 'Away')} @ {row.get('home_team', 'Home')}",
        "ml_best_side": best_side,
        "ml_odds": ml_odds,
        "ml_model_prob_pct": round(p_ml * 100, 1) if p_ml else None,
        "ml_edge_pct": round(edge_ml * 100, 1) if edge_ml else None,
        "total_side": total_side,
        "total_line": row.get("line"),
        "total_odds": tot_odds,
        "total_model_prob_pct": round(p_tot * 100, 1) if p_tot else None,
        "total_edge_pct": round(edge_tot * 100, 1) if edge_tot else None,
        "model_runs_home": round(row.get("model_mean_home"), 2) if row.get("model_mean_home") else None,
        "model_runs_away": round(row.get("model_mean_away"), 2) if row.get("model_mean_away") else None,
        "confidence": row.get("confidence"),
        "decision": row.get("card_decision"),
        "key_driver": row.get("key_driver"),
        "biggest_risk": row.get("biggest_risk"),
        "staking_pct": row.get("staking_pct"),
        "expires_at": str(row.get("game_date")) if row.get("game_date") else None
    }

import json
from datetime import datetime
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import sys, os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from mlb.api.query_player_props import query_player_props
from mlb.config import EDGE_THRESHOLD

ET = ZoneInfo('America/New_York')
PROP_MAP = {'k': 'k_strikeouts', 'hits': 'hits', 'tb': 'total_bases', 'all': None}

def _confidence_tier(prob):
    if prob >= 0.72: return 'ELITE'
    elif prob >= 0.64: return 'HIGH'
    elif prob >= 0.56: return 'MED'
    return 'LOW'

def _kelly_to_units(kelly):
    if kelly is None: return 0.5
    if kelly >= 0.04: return 2.0
    elif kelly >= 0.025: return 1.5
    elif kelly >= 0.015: return 1.0
    elif kelly >= 0.008: return 0.75
    return 0.5

def _build_alert(prop_type, line, book_odds):
    trigger = round(line + 0.5, 1) if line is not None else None
    return {'line_move_trigger': trigger, 'ev_shift_pct': 2.0, 'scratch_reject': prop_type == 'k_strikeouts', 'watch_field': 'line' if prop_type != 'k_strikeouts' else 'sp_confirmation'}

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        today_et = datetime.now(ET).strftime('%Y-%m-%d')
        date = params.get('date', [today_et])[0]
        prop_key = params.get('prop', ['all'])[0].lower()
        limit = min(int(params.get('limit', [15])[0]), 40)
        min_edge = float(params.get('min_edge', [EDGE_THRESHOLD])[0])
        only_candidates = params.get('only_candidates', ['true'])[0].lower() == 'true'
        game_id_filter = params.get('game_id', [None])[0]
        prop_type = PROP_MAP.get(prop_key)
        try:
            raw_props = query_player_props(date=date, prop_type=prop_type, limit=limit, min_edge=min_edge, only_candidates=only_candidates, game_id=game_id_filter)
        except Exception as e:
            self._send(500, {'error': str(e)})
            return
        props = []
        for row in raw_props:
            p_over = float(row.get('p_over') or 0)
            p_under = float(row.get('p_under') or 0)
            e_over = row.get('edge_over')
            e_under = row.get('edge_under')
            kelly = row.get('staking_pct')
            line = row.get('line')
            p_type = row.get('prop_type')
            book_ov = row.get('over_odds')
            if e_over is not None and (e_under is None or e_over >= e_under):
                best_side, best_edge, best_prob = 'over', e_over, p_over
            else:
                best_side, best_edge, best_prob = 'under', e_under, p_under
            props.append({'player_id': row.get('player_id'), 'player_name': row.get('player_name'), 'game_id': row.get('game_id'), 'away_team': row.get('away_team'), 'home_team': row.get('home_team'), 'game_time_et': row.get('game_time_et'), 'prop_type': p_type, 'model_mean': round(float(row.get('model_mean') or 0), 2), 'pred_lo': row.get('k_pred_lo'), 'pred_hi': row.get('k_pred_hi'), 'line': line, 'book_over_odds': book_ov, 'book_under_odds': row.get('under_odds'), 'p_over': round(p_over, 4), 'p_under': round(p_under, 4), 'edge_over': round(e_over, 4) if e_over is not None else None, 'edge_under': round(e_under, 4) if e_under is not None else None, 'best_side': best_side, 'best_edge': round(best_edge, 4) if best_edge is not None else None, 'edge_pct': f'{best_edge*100:.1f}%' if best_edge is not None else None, 'confidence_tier': _confidence_tier(best_prob), 'kelly_stake': kelly, 'suggested_units': _kelly_to_units(kelly), 'card_decision': row.get('card_decision'), 'era_xera_gap': row.get('era_xera_gap'), 'opp_sp_fip': row.get('opp_sp_fip'), 'opp_sp_xera': row.get('opp_sp_xera'), 'park_factor': row.get('park_factor'), 'bp_fatigue_flag': row.get('bp_fatigue_flag', False), 'alert': _build_alert(p_type, line, book_ov)})
        self._send(200, {'date': date, 'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'count': len(props), 'props': props})

    def _send(self, status, payload):
        body = json.dumps(payload, default=str).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args): pass

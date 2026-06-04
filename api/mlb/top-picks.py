import json
from datetime import datetime
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import sys, os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from mlb.api.query_top_picks import query_top_picks
from mlb.config import EDGE_THRESHOLD

ET = ZoneInfo('America/New_York')

def _confidence_tier(prob):
    if prob >= 0.70: return 'ELITE'
    elif prob >= 0.62: return 'HIGH'
    elif prob >= 0.55: return 'MED'
    return 'LOW'

def _prob_to_american(p):
    if not p or p <= 0 or p >= 1: return 0
    return round(-p / (1 - p) * 100) if p >= 0.5 else round((1 - p) / p * 100)

def _kelly_to_units(kelly):
    if kelly is None: return 0.5
    if kelly >= 0.04: return 2.0
    elif kelly >= 0.025: return 1.5
    elif kelly >= 0.015: return 1.0
    elif kelly >= 0.008: return 0.75
    return 0.5

def _alert_threshold(lean, book_odds, edge):
    if book_odds is None: return None
    return book_odds - 20 if book_odds < 0 else book_odds - 15

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        today_et = datetime.now(ET).strftime('%Y-%m-%d')
        date = params.get('date', [today_et])[0]
        limit = min(int(params.get('limit', [10])[0]), 25)
        market = params.get('market', ['all'])[0].lower()
        min_edge = float(params.get('min_edge', [EDGE_THRESHOLD])[0])
        try:
            raw_picks = query_top_picks(date=date, limit=limit, market_filter=market, min_edge=min_edge)
        except Exception as e:
            self._send(500, {'error': str(e)})
            return
        picks = []
        for row in raw_picks:
            prob = float(row.get('model_prob') or 0)
            book_od = row.get('book_odds')
            edge_val = float(row.get('edge') or 0)
            kelly = row.get('kelly_stake')
            picks.append({
                'game_id': row.get('game_id'),
                'away_team': row.get('away_team'),
                'home_team': row.get('home_team'),
                'game_time_et': row.get('game_time_et'),
                'market': row.get('market_type'),
                'lean': row.get('lean'),
                'lean_team': row.get('lean_team'),
                'book_odds': book_od,
                'fair_odds': _prob_to_american(prob),
                'model_prob': round(prob, 4),
                'implied_prob': round(row.get('implied_prob') or 0, 4),
                'edge': round(edge_val, 4),
                'edge_pct': f'{edge_val * 100:.1f}%',
                'confidence_tier': _confidence_tier(prob),
                'kelly_stake': kelly,
                'suggested_units': _kelly_to_units(kelly),
                'alert_threshold_odds': _alert_threshold(row.get('lean'), book_od, edge_val),
                'bp_fatigue_flag': row.get('bp_fatigue_flag', False),
                'era_xera_gap': row.get('era_xera_gap'),
                'park_factor': row.get('park_factor'),
                'signals': row.get('signals', {}),
            })
        self._send(200, {'date': date, 'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'count': len(picks), 'picks': picks})

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

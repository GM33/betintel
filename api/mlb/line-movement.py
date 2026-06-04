import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from mlb.api.query_line_movement import query_line_movement

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        game_id = params.get('game_id', [None])[0]
        if not game_id:
            self._send(400, {'error': 'game_id is required'})
            return
        market = params.get('market', ['all'])[0]
        try:
            markets = query_line_movement(game_id=game_id, market_type=market)
        except Exception as e:
            self._send(500, {'error': str(e)})
            return
        self._send(200, {'game_id': game_id, 'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'markets': markets})

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

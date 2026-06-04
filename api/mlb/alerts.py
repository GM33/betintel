import json
from datetime import datetime
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from mlb.api.query_alerts import query_alerts

ET = ZoneInfo('America/New_York')

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        today_et = datetime.now(ET).strftime('%Y-%m-%d')
        date = params.get('date', [today_et])[0]
        severity = params.get('severity', ['all'])[0].upper()
        game_id = params.get('game_id', [None])[0]
        acknowledged = params.get('acknowledged', ['false'])[0].lower() == 'true'
        limit = min(int(params.get('limit', [25])[0]), 100)
        try:
            rows = query_alerts(date=date, severity=severity, game_id=game_id, acknowledged=acknowledged, limit=limit)
        except Exception as e:
            self._send(500, {'error': str(e)})
            return
        self._send(200, {'date': date, 'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'count': len(rows), 'alerts': rows})

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

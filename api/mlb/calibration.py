import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from mlb.api.query_calibration import query_calibration

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        market = params.get('market', ['all'])[0]
        try:
            rows = query_calibration(market_filter=market)
        except Exception as e:
            self._send(500, {'error': str(e)})
            return
        grouped = {}
        for row in rows:
            mt = row['market_type']
            grouped.setdefault(mt, [])
            grouped[mt].append({'days': row['last_n_days'], 'brier_score': row['brier_score'], 'mae': row['mae'], 'roi': row['roi'], 'sample_size': row['sample_size'], 'drift_alert': row['drift_alert'], 'computed_at': row['computed_at']})
        payload = {'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'markets': [{'market_type': mt, 'windows': windows} for mt, windows in grouped.items()]}
        self._send(200, payload)

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

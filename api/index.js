// api/index.js
// Serves index.html with WS config injected server-side.
//
// Fixes applied (audit):
//  #4 — Token uses hourly HMAC rotation: betintel-ws-auth:<hourBucket>
//       Server accepts current hour and previous hour window.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end('Method Not Allowed');
    return;
  }

  const secret = process.env.WS_AUTH_SECRET || '';
  const wsUrl  = process.env.BETINTEL_WS_URL  || '';

  // FIX #4: token encodes current hour so it auto-rotates every 60 min
  const bucket = Math.floor(Date.now() / 3_600_000);
  const token  = secret
    ? crypto.createHmac('sha256', secret).update(`betintel-ws-auth:${bucket}`).digest('base64')
    : '';

  let html;
  try {
    html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  } catch (e) {
    res.status(500).send('Could not read index.html: ' + e.message);
    return;
  }

  const configScript = `<script>
  window.BETINTEL_WS_URL   = ${JSON.stringify(wsUrl)};
  window.BETINTEL_WS_TOKEN = ${JSON.stringify(token)};
</script>`;

  const injected = html.replace('<script>', configScript + '\n<script>');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.send(injected);
}

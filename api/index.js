// api/index.js
// Serves index.html with WS config injected server-side.
// No secrets are exposed in the repo — token is generated at runtime
// from WS_AUTH_SECRET stored in Vercel environment variables.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export default function handler(req, res) {
  // Only serve GET /
  if (req.method !== 'GET') {
    res.status(405).end('Method Not Allowed');
    return;
  }

  const secret = process.env.WS_AUTH_SECRET || '';
  const wsUrl  = process.env.BETINTEL_WS_URL  || '';

  // Generate per-request HMAC token so it's always fresh
  // Server validates: HMAC-SHA256(secret, 'betintel-ws-auth')
  const token = secret
    ? crypto.createHmac('sha256', secret).update('betintel-ws-auth').digest('base64')
    : '';

  let html;
  try {
    html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  } catch (e) {
    res.status(500).send('Could not read index.html: ' + e.message);
    return;
  }

  // Inject window globals immediately before the first <script> tag
  // so they are available when BetIntelOddsClient initialises
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

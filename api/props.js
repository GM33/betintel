// api/props.js — Vercel serverless proxy to Railway props endpoint
import fetch from 'node-fetch';

const RAILWAY_URL = process.env.RAILWAY_BACKEND_URL || 'https://betintel-production-a550.up.railway.app';
const TIER_MAP = { free: 0, pro: 1, elite: 2 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');

  const { sport = 'mlb', market = 'strikeouts', tier } = req.query;
  const userTier = tier || 'free';

  try {
    const upstream = await fetch(
      `${RAILWAY_URL}/props/${encodeURIComponent(sport)}/${encodeURIComponent(market)}`,
      { headers: { 'x-internal-key': process.env.INTERNAL_CRON_SECRET || '' }, signal: AbortSignal.timeout(8000) }
    );

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'upstream_error', status: upstream.status });
    }

    const data = await upstream.json();
    const props = Array.isArray(data.props) ? data.props : [];

    // Gate: free tier sees top 3, pro sees top 10, elite sees all
    const limits = { free: 3, pro: 10, elite: Infinity };
    const limit = limits[userTier] ?? 3;
    const visible = props.slice(0, limit);
    const locked = props.length > limit;

    return res.status(200).json({
      props: visible,
      locked,
      total: props.length,
      visible: visible.length,
      meta: { sport, market, userTier, refreshedAt: data.refreshedAt || new Date().toISOString() }
    });
  } catch (err) {
    console.error('[props] upstream fetch failed:', err.message);
    return res.status(503).json({ error: 'service_unavailable', message: err.message });
  }
}

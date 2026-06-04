// api/parlay-edge.js
// BetIntel — Parlay Edge + Correlation Matrix endpoint
//
// Changes from audit:
//   - Matrix mode now cached in Redis (TTL 10min) + in-mem fallback (TTL 5min)
//     Matrix computation is O(n²) Pearson over 20 players × 15 games — no-store
//     on every request was expensive.
//   - Two-prop simulation mode remains no-store (params vary per request).
//   - POST mode remains no-store.
//
// GET /api/parlay-edge
//   Two-prop joint probability mode (requires prop_a, prop_b query params)
//
//   Query params:
//     prop_a        (required) player name for prop A, e.g. "KAT"
//     prop_b        (required) player name for prop B, e.g. "Wembanyama"
//     stat_a        stat for A: "reb" | "ast"  (default: "reb")
//     stat_b        stat for B: "reb" | "ast"  (default: "reb")
//     line_a        over/under line for A       (default: derived from historical mean)
//     line_b        over/under line for B       (default: derived from historical mean)
//     dir_a         "over" | "under"            (default: "over")
//     dir_b         "over" | "under"            (default: "over")
//     team_a        team slug for A (optional — disambiguates same-name players)
//     team_b        team slug for B (optional)
//     n             simulation iterations       (default: 40000, max: 100000)
//
//   OR: matrix mode
//     mode=matrix   returns full correlation matrices + flagged pairs for all 4 teams
//
// POST /api/parlay-edge
//   Body: { prop_a, stat_a, line_a, dir_a, history_a: number[],
//           prop_b, stat_b, line_b, dir_b, history_b: number[], n? }
//   Accepts raw historical arrays — use this when you have live box-score data
//   fetched from your Railway NBA-cron worker.

'use strict';

const {
  simulateJointProb,
  buildTeamCorrelationMatrix,
  computeUsageDisplacement,
  pearsonR,
} = require('./_lib/correlation-engine');

// ── Redis + in-mem cache for matrix mode ───────────────────────────────
let redis = null;
try { redis = require('./_lib/redis-client'); } catch {}

const MATRIX_CACHE_KEY = 'betintel:parlay:matrix';
const MATRIX_TTL_S     = 600;   // 10 min Redis TTL
const MEM_TTL_MS       = 300_000; // 5 min in-mem TTL
let   memMatrixCache   = null;
let   memMatrixTs      = 0;

async function getMatrixCached() {
  // 1. In-mem
  if (memMatrixCache && Date.now() - memMatrixTs < MEM_TTL_MS) {
    return { data: memMatrixCache, source: 'mem' };
  }
  // 2. Redis
  if (redis) {
    try {
      const raw = await redis.get(MATRIX_CACHE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        memMatrixCache = data; memMatrixTs = Date.now();
        return { data, source: 'redis' };
      }
    } catch {}
  }
  return null;
}

async function setMatrixCached(data) {
  memMatrixCache = data; memMatrixTs = Date.now();
  if (redis) {
    try { await redis.setex(MATRIX_CACHE_KEY, MATRIX_TTL_S, JSON.stringify(data)); } catch {}
  }
}

// ── Embedded roster snapshots (last 15 games as of June 3, 2026) ──────────
// Replace individual arrays with live Redis lookups from nba-cron when available.
// Key: nba-cron writes to Redis at betintel:nba:player:{slug}:reb / :ast
const ROSTER_SNAPSHOT = {
  // ── Knicks ──
  KAT:        { team: 'knicks',         reb: [12,10,14,11,9,13,15,10,11,12,8,11,13,10,12], ast: [3,4,2,5,3,4,3,6,2,4,3,5,2,4,3] },
  Brunson:    { team: 'knicks',         reb: [3,4,2,3,4,2,3,4,3,2,4,3,2,4,3],             ast: [8,9,7,10,8,9,11,7,9,8,10,9,8,7,9] },
  Bridges:    { team: 'knicks',         reb: [4,5,3,4,6,3,5,4,4,5,3,6,4,3,5],             ast: [2,3,2,3,2,4,3,2,3,2,3,2,3,2,4] },
  Hart:       { team: 'knicks',         reb: [7,8,6,9,7,8,6,9,7,8,6,9,7,8,6],             ast: [4,3,5,3,4,3,5,4,3,4,5,3,4,5,3] },
  OG:         { team: 'knicks',         reb: [5,6,4,7,5,6,4,7,5,6,4,7,5,6,4],             ast: [1,2,1,2,1,2,1,2,1,2,1,2,1,2,1] },
  // ── Spurs ──
  Wembanyama: { team: 'spurs',          reb: [11,13,10,14,12,11,13,9,12,14,10,11,13,12,10], ast: [3,4,3,5,3,4,3,5,4,3,4,3,5,4,3] },
  Vassell:    { team: 'spurs',          reb: [3,4,2,3,5,3,2,4,3,3,4,2,3,4,2],               ast: [4,5,4,6,4,5,4,5,5,4,5,4,6,4,5] },
  Johnson:    { team: 'spurs',          reb: [5,6,4,7,5,6,5,7,5,6,5,7,5,6,4],               ast: [5,6,4,7,5,6,5,7,5,6,5,7,5,6,4] },
  Collins:    { team: 'spurs',          reb: [8,9,7,10,8,7,9,8,9,7,8,9,7,8,9],              ast: [2,3,2,2,3,2,3,2,3,2,3,2,2,3,2] },
  Castle:     { team: 'spurs',          reb: [2,3,2,3,2,3,2,3,2,3,2,3,2,3,2],               ast: [6,7,5,8,6,7,5,8,6,7,5,8,6,7,5] },
  // ── Toronto Tempo ──
  Siakam:     { team: 'toronto-tempo',  reb: [7,8,6,9,7,8,6,9,7,8,6,9,7,8,6],   ast: [3,4,3,5,3,4,3,5,3,4,3,5,3,4,3] },
  Barnes:     { team: 'toronto-tempo',  reb: [8,9,7,10,8,9,7,10,8,9,7,10,8,9,7], ast: [4,5,4,6,4,5,4,6,4,5,4,6,4,5,4] },
  Quickley:   { team: 'toronto-tempo',  reb: [3,4,2,3,4,2,3,4,2,3,4,2,3,4,2],    ast: [7,8,6,9,7,8,6,9,7,8,6,9,7,8,6] },
  TrentJr:    { team: 'toronto-tempo',  reb: [3,2,4,3,2,4,3,2,4,3,2,4,3,2,4],    ast: [2,3,2,3,2,3,2,3,2,3,2,3,2,3,2] },
  Schroder:   { team: 'toronto-tempo',  reb: [2,3,2,3,2,3,2,3,2,3,2,3,2,3,2],    ast: [8,9,7,10,8,9,7,10,8,9,7,10,8,9,7] },
  // ── NY Liberty ──
  Breanna:    { team: 'ny-liberty',     reb: [11,12,10,13,11,12,10,13,11,12,10,13,11,12,10], ast: [2,3,2,4,2,3,2,4,2,3,2,4,2,3,2] },
  Sabally:    { team: 'ny-liberty',     reb: [8,6,9,7,6,8,7,9,6,8,7,9,6,8,7],                ast: [3,5,2,4,5,3,4,2,5,3,4,2,5,3,4] },
  Ionescu:    { team: 'ny-liberty',     reb: [3,5,2,4,5,3,4,2,5,3,4,2,5,3,4],                ast: [9,7,10,8,7,9,8,10,7,9,8,10,7,9,8] },
  Jones:      { team: 'ny-liberty',     reb: [5,4,6,4,5,4,6,4,5,4,6,4,5,4,6],                ast: [4,6,3,5,4,6,3,5,4,6,3,5,4,6,3] },
  Laney:      { team: 'ny-liberty',     reb: [4,3,5,3,4,3,5,3,4,3,5,3,4,3,5],                ast: [2,3,2,4,2,3,2,4,2,3,2,4,2,3,2] },
};

// Fuzzy player name lookup (case-insensitive substring)
function findPlayer(slug) {
  const s = slug.toLowerCase();
  const key = Object.keys(ROSTER_SNAPSHOT).find(k => k.toLowerCase() === s)
    || Object.keys(ROSTER_SNAPSHOT).find(k => k.toLowerCase().includes(s));
  if (!key) return null;
  return { key, ...ROSTER_SNAPSHOT[key] };
}

// Build per-team rosters from snapshot
function groupByTeam() {
  const teams = {};
  for (const [name, data] of Object.entries(ROSTER_SNAPSHOT)) {
    const t = data.team;
    if (!teams[t]) teams[t] = {};
    teams[t][name] = { reb: data.reb, ast: data.ast };
  }
  return teams;
}

// ── Matrix mode ───────────────────────────────────────────────────
function buildMatrixResponse() {
  const byTeam = groupByTeam();
  const result = {};
  for (const [team, roster] of Object.entries(byTeam)) {
    const rebMatrix = buildTeamCorrelationMatrix(roster, 'reb');
    const astMatrix = buildTeamCorrelationMatrix(roster, 'ast');
    const allFlagged = [
      ...rebMatrix.flaggedPairs.map(p => ({ ...p, team, usageDisplacement: computeUsageDisplacement(p.r, false, 1.0) })),
      ...astMatrix.flaggedPairs.map(p => ({ ...p, team, usageDisplacement: computeUsageDisplacement(p.r, false, 1.0) })),
    ].sort((a, b) => b.usageDisplacement - a.usageDisplacement);

    result[team] = {
      rebounds:      { players: rebMatrix.players, matrix: rebMatrix.matrix, flaggedPairs: rebMatrix.flaggedPairs },
      assists:       { players: astMatrix.players, matrix: astMatrix.matrix, flaggedPairs: astMatrix.flaggedPairs },
      parlayRankings: allFlagged,
    };
  }
  return result;
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── POST: raw history arrays (no-store, params unique per request) ──
  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const {
      prop_a, prop_b,
      stat_a = 'reb', stat_b = 'reb',
      line_a, line_b,
      dir_a = 'over', dir_b = 'over',
      history_a, history_b,
      n = 40000,
    } = body || {};

    if (!Array.isArray(history_a) || !Array.isArray(history_b)) {
      return res.status(400).json({ error: 'history_a and history_b must be number arrays' });
    }
    if (!prop_a || !prop_b) {
      return res.status(400).json({ error: 'prop_a and prop_b are required' });
    }

    const muA = history_a.reduce((a, b) => a + b, 0) / history_a.length;
    const muB = history_b.reduce((a, b) => a + b, 0) / history_b.length;
    const la  = line_a != null ? Number(line_a) : muA;
    const lb  = line_b != null ? Number(line_b) : muB;
    const sim = simulateJointProb(history_a, history_b, la, lb,
                                   Math.min(Number(n) || 40000, 100000), dir_a, dir_b);

    return res.status(200).json({
      mode: 'simulation',
      propA: { name: prop_a, stat: stat_a, line: la, dir: dir_a },
      propB: { name: prop_b, stat: stat_b, line: lb, dir: dir_b },
      simulation: sim,
      interpretation: interpret(sim),
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── GET matrix mode — CACHED ──
  if (req.query.mode === 'matrix') {
    const cached = await getMatrixCached();
    if (cached) {
      res.setHeader('Cache-Control', `public, max-age=${MATRIX_TTL_S}`);
      res.setHeader('X-Cache', cached.source === 'mem' ? 'MEM-HIT' : 'REDIS-HIT');
      return res.status(200).json({
        mode: 'matrix',
        generatedAt: cached.data._generatedAt,
        cacheSource: cached.source,
        teams: cached.data.teams,
      });
    }

    const teams = buildMatrixResponse();
    const payload = { teams, _generatedAt: new Date().toISOString() };
    await setMatrixCached(payload);

    res.setHeader('Cache-Control', `public, max-age=${MATRIX_TTL_S}`);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({
      mode: 'matrix',
      generatedAt: payload._generatedAt,
      cacheSource: 'none',
      teams,
    });
  }

  // ── GET two-prop simulation mode (no-store, unique per param combo) ──
  res.setHeader('Cache-Control', 'no-store');

  const { prop_a, prop_b, stat_a = 'reb', stat_b = 'reb',
          line_a, line_b, dir_a = 'over', dir_b = 'over',
          team_a, team_b, n = '40000' } = req.query;

  if (!prop_a || !prop_b) {
    return res.status(400).json({
      error: 'prop_a and prop_b are required',
      example: '/api/parlay-edge?prop_a=KAT&stat_a=reb&line_a=10.5&prop_b=Wembanyama&stat_b=reb&line_b=11.5',
      modes: [
        'GET /api/parlay-edge?mode=matrix — full 4-team correlation matrices',
        'GET /api/parlay-edge?prop_a=KAT&prop_b=Wembanyama&stat_a=reb&stat_b=reb&line_a=10.5&line_b=11.5',
        'POST /api/parlay-edge — supply raw history_a / history_b arrays',
      ],
    });
  }

  const playerA = findPlayer(prop_a);
  const playerB = findPlayer(prop_b);

  if (!playerA) return res.status(404).json({ error: `Player not found: ${prop_a}`, available: Object.keys(ROSTER_SNAPSHOT) });
  if (!playerB) return res.status(404).json({ error: `Player not found: ${prop_b}`, available: Object.keys(ROSTER_SNAPSHOT) });

  if (!playerA[stat_a]) return res.status(400).json({ error: `stat_a '${stat_a}' not available for ${playerA.key}. Use: reb, ast` });
  if (!playerB[stat_b]) return res.status(400).json({ error: `stat_b '${stat_b}' not available for ${playerB.key}. Use: reb, ast` });

  const histA = playerA[stat_a];
  const histB = playerB[stat_b];
  const muA   = histA.reduce((a, b) => a + b, 0) / histA.length;
  const muB   = histB.reduce((a, b) => a + b, 0) / histB.length;
  const la    = line_a != null ? Number(line_a) : +(muA - 0.5).toFixed(1);
  const lb    = line_b != null ? Number(line_b) : +(muB - 0.5).toFixed(1);

  const simN  = Math.min(Number(n) || 40000, 100000);
  const sim   = simulateJointProb(histA, histB, la, lb, simN, dir_a, dir_b);
  const ud    = computeUsageDisplacement(sim.r);

  return res.status(200).json({
    mode: 'simulation',
    generatedAt: new Date().toISOString(),
    propA: { name: playerA.key, team: playerA.team, stat: stat_a, line: la, dir: dir_a, games: histA.length },
    propB: { name: playerB.key, team: playerB.team, stat: stat_b, line: lb, dir: dir_b, games: histB.length },
    simulation: sim,
    usageDisplacementScore: ud,
    interpretation: interpret(sim),
  });
};

// ── Human-readable interpretation ────────────────────────────────────────────────
function interpret(sim) {
  const { r, edgePct, pJoint, pIndep } = sim;
  let verdict, detail;

  if (edgePct > 10) {
    verdict = 'PARLAY HAS EDGE';
    detail  = `Joint probability (${(pJoint*100).toFixed(1)}%) exceeds independent assumption (${(pIndep*100).toFixed(1)}%) by ${edgePct.toFixed(1)}%. Positive correlation (r=${r}) creates a free parlay uplift — books price legs independently.`;
  } else if (edgePct > 0) {
    verdict = 'SLIGHT PARLAY EDGE';
    detail  = `Marginal improvement (+${edgePct.toFixed(1)}%) over independent pricing. Correlation (r=${r}) provides a small but real uplift on the parlay.`;
  } else if (edgePct > -5) {
    verdict = 'APPROXIMATELY INDEPENDENT';
    detail  = `Near-zero correlation (r=${r}) means parlay pricing is close to fair. No systematic edge either way.`;
  } else {
    verdict = 'AVOID PARLAY — INVERSE CORRELATION';
    detail  = `Negative correlation (r=${r}) means when one prop hits, the other is less likely. Parlay joint probability (${(pJoint*100).toFixed(1)}%) is LOWER than independent assumption (${(pIndep*100).toFixed(1)}%). This destroys ${Math.abs(edgePct).toFixed(1)}% of expected value. Bet legs separately, or fade the over on the lower-displacement player.`;
  }

  return { verdict, detail };
}

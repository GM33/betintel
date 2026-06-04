// js/props.js — BetIntel PropCard renderer (vanilla JS)
(function () {
  'use strict';

  const POLL_MS = 5 * 60 * 1000; // 5 minutes
  const CONF_COLORS = { Strong: '#22c55e', Value: '#facc15', Marginal: '#f97316', 'No Edge': '#6b7280' };
  const CONF_BORDER = { Strong: '#16a34a', Value: '#ca8a04', Marginal: '#ea580c', 'No Edge': '#4b5563' };

  function getUserTier() {
    try { return JSON.parse(localStorage.getItem('bi_user') || '{}').tier || 'free'; } catch { return 'free'; }
  }

  function renderUpgradeModal() {
    const existing = document.getElementById('bi-upgrade-modal');
    if (existing) { existing.style.display = 'flex'; return; }
    const modal = document.createElement('div');
    modal.id = 'bi-upgrade-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:9999;';
    modal.innerHTML = `
      <div style="background:#111827;border:1px solid #374151;border-radius:12px;padding:32px;max-width:420px;width:90%;text-align:center;">
        <div style="font-size:2rem;margin-bottom:12px;">🔒</div>
        <h2 style="color:#f9fafb;font-size:1.25rem;font-weight:700;margin-bottom:8px;">Unlock All Props</h2>
        <p style="color:#9ca3af;font-size:0.9rem;margin-bottom:20px;">Free tier shows top 3 props. Upgrade to <strong style="color:#22c55e;">BetIntel Pro</strong> for full access — live edge scores, all markets, and CLV tracking.</p>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button onclick="document.getElementById('bi-upgrade-modal').style.display='none'" style="background:#374151;color:#d1d5db;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:0.875rem;">Maybe Later</button>
          <a href="/pricing" style="background:#22c55e;color:#000;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.875rem;">Upgrade — $25/mo</a>
        </div>
      </div>`;
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
    document.body.appendChild(modal);
  }

  function renderPropCard(prop) {
    const conf = prop.confidence || 'Marginal';
    const color = CONF_COLORS[conf] || '#6b7280';
    const border = CONF_BORDER[conf] || '#4b5563';
    const edge = prop.edge >= 0 ? `+${prop.edge.toFixed(1)}%` : `${prop.edge.toFixed(1)}%`;
    const signals = Array.isArray(prop.signals) ? prop.signals.slice(0, 3) : [];

    return `
      <div class="bi-prop-card" style="background:#1f2937;border-left:4px solid ${border};border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <div>
            <span style="color:#f9fafb;font-weight:700;font-size:1rem;">${prop.pitcher || prop.player || '—'}</span>
            <span style="color:#6b7280;font-size:0.8rem;margin-left:8px;">${prop.matchup || ''}</span>
          </div>
          <span style="background:${color}20;color:${color};border:1px solid ${color}40;padding:2px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;">${conf}</span>
        </div>
        <div style="display:flex;gap:16px;margin-bottom:10px;align-items:center;">
          <span style="color:#9ca3af;font-size:0.85rem;">Line: <strong style="color:#f9fafb;">${prop.line || '—'}</strong></span>
          <span style="color:#9ca3af;font-size:0.85rem;">Edge: <strong style="color:${color};">${edge}</strong></span>
          <span style="color:#9ca3af;font-size:0.85rem;">Best Odds: <strong style="color:#f9fafb;">${prop.best_odds || '—'}</strong></span>
        </div>
        ${signals.length ? `<ul style="margin:0;padding-left:16px;">${signals.map(s => `<li style="color:#9ca3af;font-size:0.8rem;">${s}</li>`).join('')}</ul>` : ''}
      </div>`;
  }

  function renderLockedCard() {
    return `
      <div class="bi-prop-card bi-locked" style="background:#1f2937;border-left:4px solid #374151;border-radius:8px;padding:16px;margin-bottom:12px;opacity:0.5;cursor:pointer;position:relative;" onclick="window.BetIntel.showUpgrade()">
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(17,24,39,0.6);border-radius:8px;">
          <span style="color:#9ca3af;font-size:0.85rem;">🔒 Upgrade to unlock</span>
        </div>
        <div style="filter:blur(4px);pointer-events:none;">
          <div style="height:14px;background:#374151;border-radius:4px;width:60%;margin-bottom:8px;"></div>
          <div style="height:10px;background:#374151;border-radius:4px;width:40%;margin-bottom:8px;"></div>
          <div style="height:10px;background:#374151;border-radius:4px;width:80%;"></div>
        </div>
      </div>`;
  }

  async function loadProps(container, sport, market) {
    const tier = getUserTier();
    container.innerHTML = `<div style="color:#6b7280;font-size:0.85rem;padding:16px;">Loading props…</div>`;

    try {
      const res = await fetch(`/api/props?sport=${sport}&market=${market}&tier=${tier}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!data.props || !data.props.length) {
        container.innerHTML = `<div style="color:#6b7280;font-size:0.85rem;padding:16px;">No props available right now.</div>`;
        return;
      }

      let html = data.props.map(renderPropCard).join('');

      if (data.locked) {
        const hiddenCount = data.total - data.visible;
        for (let i = 0; i < Math.min(hiddenCount, 3); i++) html += renderLockedCard();
        html += `<div style="text-align:center;margin-top:8px;">
          <button onclick="window.BetIntel.showUpgrade()" style="background:#22c55e;color:#000;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.875rem;">Unlock ${hiddenCount} More Props</button>
        </div>`;
      }

      const refreshed = data.meta?.refreshedAt ? new Date(data.meta.refreshedAt).toLocaleTimeString() : '—';
      html += `<div style="color:#4b5563;font-size:0.75rem;text-align:right;margin-top:8px;">Last updated: ${refreshed}</div>`;
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<div style="color:#ef4444;font-size:0.85rem;padding:16px;">Props unavailable — retrying in 5 min.</div>`;
      console.error('[BetIntel props]', err);
    }
  }

  window.BetIntel = window.BetIntel || {};
  window.BetIntel.showUpgrade = renderUpgradeModal;
  window.BetIntel.initProps = function (containerId, sport = 'mlb', market = 'strikeouts') {
    const container = document.getElementById(containerId);
    if (!container) return;
    loadProps(container, sport, market);
    setInterval(() => loadProps(container, sport, market), POLL_MS);
  };
})();

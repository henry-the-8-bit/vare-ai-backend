import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { systemAlertsTable, merchantsTable } from "@workspace/db/schema";
import { eq, and, desc, sql, gte, isNull, count as drizzleCount } from "drizzle-orm";
import { successResponse, errorResponse } from "../lib/response.js";

const router = Router();

// ── GET /admin/status — Serve the lightweight HTML status dashboard ──
router.get("/admin/status", (req: Request, res: Response) => {
  // If Accept header prefers JSON, skip the HTML page
  if (req.headers.accept?.includes("application/json")) {
    res.redirect("/api/admin/status/summary");
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.send(STATUS_PAGE_HTML);
});

/**
 * Admin auth: requires ADMIN_API_KEY env var in Authorization header.
 * This is a simple shared secret for internal use — not merchant-scoped.
 */
function requireAdminAuth(req: Request, res: Response, next: () => void) {
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!adminKey) {
    errorResponse(res, "Admin API not configured", "NOT_CONFIGURED", 503);
    return;
  }

  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7) !== adminKey) {
    errorResponse(res, "Invalid admin credentials", "UNAUTHORIZED", 401);
    return;
  }

  next();
}

// ── GET /admin/status/summary — Aggregate stats across all merchants ──
router.get("/admin/status/summary", requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    // Counts by severity
    const severityCounts = await db
      .select({
        severity: systemAlertsTable.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(systemAlertsTable)
      .where(isNull(systemAlertsTable.dismissedAt))
      .groupBy(systemAlertsTable.severity);

    // Counts by category
    const categoryCounts = await db
      .select({
        category: systemAlertsTable.category,
        count: sql<number>`count(*)::int`,
      })
      .from(systemAlertsTable)
      .where(isNull(systemAlertsTable.dismissedAt))
      .groupBy(systemAlertsTable.category);

    // Unread count
    const [unreadResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(systemAlertsTable)
      .where(and(eq(systemAlertsTable.isRead, false), isNull(systemAlertsTable.dismissedAt)));

    // Total active alerts
    const [totalResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(systemAlertsTable)
      .where(isNull(systemAlertsTable.dismissedAt));

    // Alerts in last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [last24hResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(systemAlertsTable)
      .where(and(isNull(systemAlertsTable.dismissedAt), gte(systemAlertsTable.createdAt, oneDayAgo)));

    // Alerts in last 1h
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [lastHourResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(systemAlertsTable)
      .where(and(isNull(systemAlertsTable.dismissedAt), gte(systemAlertsTable.createdAt, oneHourAgo)));

    // Merchant count
    const [merchantCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(merchantsTable);

    // Affected merchants (merchants with unread alerts)
    const [affectedMerchants] = await db
      .select({ count: sql<number>`count(distinct merchant_id)::int` })
      .from(systemAlertsTable)
      .where(and(eq(systemAlertsTable.isRead, false), isNull(systemAlertsTable.dismissedAt)));

    successResponse(res, {
      total: totalResult?.count ?? 0,
      unread: unreadResult?.count ?? 0,
      last24h: last24hResult?.count ?? 0,
      lastHour: lastHourResult?.count ?? 0,
      totalMerchants: merchantCount?.count ?? 0,
      affectedMerchants: affectedMerchants?.count ?? 0,
      bySeverity: Object.fromEntries(severityCounts.map((r) => [r.severity ?? "unknown", r.count])),
      byCategory: Object.fromEntries(categoryCounts.map((r) => [r.category ?? "unknown", r.count])),
    });
  } catch (err: unknown) {
    errorResponse(res, String(err), "INTERNAL_ERROR", 500);
  }
});

// ── GET /admin/status/alerts — Recent alerts across all merchants ──
router.get("/admin/status/alerts", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 200);
    const offset = parseInt(req.query["offset"] as string) || 0;
    const severity = req.query["severity"] as string | undefined;
    const category = req.query["category"] as string | undefined;
    const unreadOnly = req.query["unread"] === "true";

    const conditions = [isNull(systemAlertsTable.dismissedAt)];
    if (severity) conditions.push(eq(systemAlertsTable.severity, severity));
    if (category) conditions.push(eq(systemAlertsTable.category, category));
    if (unreadOnly) conditions.push(eq(systemAlertsTable.isRead, false));

    const alerts = await db
      .select({
        id: systemAlertsTable.id,
        merchantId: systemAlertsTable.merchantId,
        severity: systemAlertsTable.severity,
        category: systemAlertsTable.category,
        source: systemAlertsTable.source,
        title: systemAlertsTable.title,
        description: systemAlertsTable.description,
        suggestion: systemAlertsTable.suggestion,
        relatedEntityType: systemAlertsTable.relatedEntityType,
        isRead: systemAlertsTable.isRead,
        createdAt: systemAlertsTable.createdAt,
        merchantName: merchantsTable.companyName,
        merchantSlug: merchantsTable.slug,
      })
      .from(systemAlertsTable)
      .leftJoin(merchantsTable, eq(systemAlertsTable.merchantId, merchantsTable.id))
      .where(and(...conditions))
      .orderBy(desc(systemAlertsTable.createdAt))
      .limit(limit)
      .offset(offset);

    successResponse(res, alerts);
  } catch (err: unknown) {
    errorResponse(res, String(err), "INTERNAL_ERROR", 500);
  }
});

// ── GET /admin/status/merchants — Per-merchant alert counts ──
router.get("/admin/status/merchants", requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const merchantStats = await db
      .select({
        merchantId: systemAlertsTable.merchantId,
        merchantName: merchantsTable.companyName,
        merchantSlug: merchantsTable.slug,
        isLive: merchantsTable.isLive,
        total: sql<number>`count(*)::int`,
        unread: sql<number>`count(*) filter (where is_read = false)::int`,
        critical: sql<number>`count(*) filter (where severity = 'critical')::int`,
        errors: sql<number>`count(*) filter (where severity = 'error')::int`,
        warnings: sql<number>`count(*) filter (where severity = 'warning')::int`,
      })
      .from(systemAlertsTable)
      .leftJoin(merchantsTable, eq(systemAlertsTable.merchantId, merchantsTable.id))
      .where(isNull(systemAlertsTable.dismissedAt))
      .groupBy(systemAlertsTable.merchantId, merchantsTable.companyName, merchantsTable.slug, merchantsTable.isLive)
      .orderBy(sql`count(*) filter (where severity = 'critical') desc, count(*) filter (where severity = 'error') desc`);

    successResponse(res, merchantStats);
  } catch (err: unknown) {
    errorResponse(res, String(err), "INTERNAL_ERROR", 500);
  }
});

// ── GET /admin/status/timeline — Alerts over time (last 7 days, hourly buckets) ──
router.get("/admin/status/timeline", requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const timeline = await db
      .select({
        bucket: sql<string>`date_trunc('hour', created_at)::text`,
        count: sql<number>`count(*)::int`,
        critical: sql<number>`count(*) filter (where severity = 'critical')::int`,
        errors: sql<number>`count(*) filter (where severity = 'error')::int`,
        warnings: sql<number>`count(*) filter (where severity = 'warning')::int`,
        info: sql<number>`count(*) filter (where severity = 'info')::int`,
      })
      .from(systemAlertsTable)
      .where(gte(systemAlertsTable.createdAt, sevenDaysAgo))
      .groupBy(sql`date_trunc('hour', created_at)`)
      .orderBy(sql`date_trunc('hour', created_at)`);

    successResponse(res, timeline);
  } catch (err: unknown) {
    errorResponse(res, String(err), "INTERNAL_ERROR", 500);
  }
});

// ── Lightweight HTML status dashboard ──
const STATUS_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Vare AI — System Status</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--text:#e2e2e8;--muted:#6b6b80;--accent:#6366f1;--green:#22c55e;--yellow:#eab308;--orange:#f97316;--red:#ef4444;--blue:#3b82f6}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  .container{max-width:1200px;margin:0 auto;padding:24px}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}
  header h1{font-size:20px;font-weight:600;letter-spacing:-0.02em}
  header h1 span{color:var(--accent)}
  .badge{font-size:11px;padding:4px 10px;border-radius:999px;font-weight:500}
  .badge-green{background:rgba(34,197,94,.15);color:var(--green)}
  .badge-red{background:rgba(239,68,68,.15);color:var(--red)}
  .badge-yellow{background:rgba(234,179,8,.15);color:var(--yellow)}
  .auth-gate{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:16px}
  .auth-gate input{background:var(--card);border:1px solid var(--border);color:var(--text);padding:10px 16px;border-radius:8px;width:320px;font-size:14px;outline:none}
  .auth-gate input:focus{border-color:var(--accent)}
  .auth-gate button{background:var(--accent);color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;cursor:pointer;font-weight:500}
  .auth-gate button:hover{opacity:.9}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px}
  .stat .label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  .stat .value{font-size:28px;font-weight:700;letter-spacing:-0.02em}
  .stat .value.critical{color:var(--red)}
  .stat .value.warning{color:var(--yellow)}
  .stat .value.good{color:var(--green)}
  .section{margin-bottom:24px}
  .section h2{font-size:14px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
  .severity-bars{display:flex;gap:8px;flex-wrap:wrap}
  .sev-bar{flex:1;min-width:120px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center}
  .sev-bar .count{font-size:24px;font-weight:700;margin-bottom:2px}
  .sev-bar .sev-label{font-size:11px;color:var(--muted);text-transform:uppercase}
  .sev-critical .count{color:var(--red)}
  .sev-error .count{color:var(--orange)}
  .sev-warning .count{color:var(--yellow)}
  .sev-info .count{color:var(--blue)}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  th{text-align:left;padding:10px 14px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border);background:rgba(255,255,255,.02)}
  td{padding:10px 14px;font-size:13px;border-bottom:1px solid var(--border)}
  tr:last-child td{border-bottom:none}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .dot-critical{background:var(--red)}
  .dot-error{background:var(--orange)}
  .dot-warning{background:var(--yellow)}
  .dot-info{background:var(--blue)}
  .timeline-chart{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;overflow-x:auto}
  .timeline-chart canvas{width:100%;height:200px}
  .refresh{font-size:11px;color:var(--muted)}
  .merchants-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
  .merchant-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px}
  .merchant-card h3{font-size:14px;font-weight:600;margin-bottom:4px}
  .merchant-card .slug{font-size:11px;color:var(--muted);margin-bottom:10px}
  .merchant-counts{display:flex;gap:12px}
  .merchant-counts .mc{text-align:center}
  .merchant-counts .mc .num{font-size:18px;font-weight:700}
  .merchant-counts .mc .lbl{font-size:10px;color:var(--muted);text-transform:uppercase}
  .error-msg{color:var(--red);font-size:13px;text-align:center;padding:24px}
  .loading{text-align:center;color:var(--muted);padding:24px;font-size:13px}
  .tabs{display:flex;gap:4px;margin-bottom:16px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:4px;width:fit-content}
  .tab{padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;color:var(--muted);border:none;background:none;font-weight:500}
  .tab.active{background:var(--accent);color:#fff}
  .tab:hover:not(.active){color:var(--text)}
</style>
</head>
<body>
<div class="container" id="app">
  <div class="auth-gate" id="auth-gate">
    <h1>Vare AI <span>Status</span></h1>
    <p style="color:var(--muted);font-size:13px">Enter admin API key to continue</p>
    <input type="password" id="key-input" placeholder="Admin API Key" autocomplete="off"/>
    <button onclick="authenticate()">Authenticate</button>
    <p id="auth-error" style="color:var(--red);font-size:12px;display:none"></p>
  </div>
  <div id="dashboard" style="display:none">
    <header>
      <h1>Vare AI <span>Status</span></h1>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="refresh" id="last-refresh"></span>
        <span class="badge" id="health-badge">Loading...</span>
      </div>
    </header>
    <div class="stats" id="stats-grid"></div>
    <div class="section">
      <h2>Alerts by Severity</h2>
      <div class="severity-bars" id="severity-bars"></div>
    </div>
    <div class="section">
      <div class="tabs">
        <button class="tab active" onclick="switchTab('alerts',this)">Recent Alerts</button>
        <button class="tab" onclick="switchTab('merchants',this)">Merchants</button>
        <button class="tab" onclick="switchTab('timeline',this)">Timeline</button>
      </div>
      <div id="tab-alerts"></div>
      <div id="tab-merchants" style="display:none"></div>
      <div id="tab-timeline" style="display:none"></div>
    </div>
  </div>
</div>
<script>
const API_BASE = window.location.origin + '/api';
let API_KEY = '';
let refreshTimer;

function authenticate() {
  API_KEY = document.getElementById('key-input').value.trim();
  if (!API_KEY) return;
  document.getElementById('auth-error').style.display = 'none';
  apiFetch('/admin/status/summary').then(r => {
    if (!r.ok) throw new Error('Invalid key');
    return r.json();
  }).then(() => {
    localStorage.setItem('vare_admin_key', API_KEY);
    document.getElementById('auth-gate').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    loadAll();
    refreshTimer = setInterval(loadAll, 30000);
  }).catch(() => {
    const el = document.getElementById('auth-error');
    el.textContent = 'Invalid API key';
    el.style.display = 'block';
  });
}

function apiFetch(path) {
  return fetch(API_BASE + path, { headers: { 'Authorization': 'Bearer ' + API_KEY } });
}

// Auto-login from localStorage
(function() {
  const saved = localStorage.getItem('vare_admin_key');
  if (saved) {
    document.getElementById('key-input').value = saved;
    authenticate();
  }
  document.getElementById('key-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') authenticate();
  });
})();

async function loadAll() {
  try {
    const [summaryRes, alertsRes, merchantsRes, timelineRes] = await Promise.all([
      apiFetch('/admin/status/summary'),
      apiFetch('/admin/status/alerts?limit=50'),
      apiFetch('/admin/status/merchants'),
      apiFetch('/admin/status/timeline'),
    ]);
    const summary = (await summaryRes.json()).data;
    const alerts = (await alertsRes.json()).data;
    const merchants = (await merchantsRes.json()).data;
    const timeline = (await timelineRes.json()).data;
    renderSummary(summary);
    renderAlerts(alerts);
    renderMerchants(merchants);
    renderTimeline(timeline);
    document.getElementById('last-refresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error('Load failed', e);
  }
}

function renderSummary(s) {
  const critical = (s.bySeverity.critical || 0);
  const errors = (s.bySeverity.error || 0);
  const healthClass = critical > 0 ? 'critical' : errors > 0 ? 'warning' : 'good';
  const badge = document.getElementById('health-badge');
  badge.textContent = critical > 0 ? 'Issues Detected' : errors > 0 ? 'Warnings' : 'All Systems Normal';
  badge.className = 'badge ' + (critical > 0 ? 'badge-red' : errors > 0 ? 'badge-yellow' : 'badge-green');

  document.getElementById('stats-grid').innerHTML = [
    stat('Total Active', s.total, s.total > 10 ? 'warning' : 'good'),
    stat('Unread', s.unread, s.unread > 5 ? 'warning' : 'good'),
    stat('Last Hour', s.lastHour, s.lastHour > 5 ? 'critical' : 'good'),
    stat('Last 24h', s.last24h, ''),
    stat('Merchants', s.totalMerchants, ''),
    stat('Affected', s.affectedMerchants, s.affectedMerchants > 0 ? 'warning' : 'good'),
  ].join('');

  const sevOrder = ['critical','error','warning','info'];
  document.getElementById('severity-bars').innerHTML = sevOrder.map(sev =>
    '<div class="sev-bar sev-' + sev + '"><div class="count">' + (s.bySeverity[sev] || 0) + '</div><div class="sev-label">' + sev + '</div></div>'
  ).join('');
}

function stat(label, value, cls) {
  return '<div class="stat"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>';
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    document.getElementById('tab-alerts').innerHTML = '<p class="loading">No active alerts</p>';
    return;
  }
  let html = '<table><thead><tr><th>Severity</th><th>Title</th><th>Merchant</th><th>Category</th><th>Time</th></tr></thead><tbody>';
  alerts.forEach(a => {
    const time = timeAgo(a.createdAt);
    html += '<tr><td><span class="dot dot-' + (a.severity || 'info') + '"></span>' + (a.severity || 'info') + '</td>';
    html += '<td>' + esc(a.title) + '<br><span style="font-size:11px;color:var(--muted)">' + esc(a.description || '') + '</span></td>';
    html += '<td>' + esc(a.merchantName || a.merchantSlug || '—') + '</td>';
    html += '<td>' + esc(a.category || '—') + '</td>';
    html += '<td style="white-space:nowrap">' + time + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('tab-alerts').innerHTML = html;
}

function renderMerchants(merchants) {
  if (!merchants.length) {
    document.getElementById('tab-merchants').innerHTML = '<p class="loading">No merchant alerts</p>';
    return;
  }
  let html = '<div class="merchants-grid">';
  merchants.forEach(m => {
    html += '<div class="merchant-card">';
    html += '<h3>' + esc(m.merchantName || 'Unknown') + '</h3>';
    html += '<div class="slug">' + esc(m.merchantSlug || m.merchantId) + (m.isLive ? ' — <span style="color:var(--green)">Live</span>' : '') + '</div>';
    html += '<div class="merchant-counts">';
    html += mc(m.critical, 'Critical', 'var(--red)');
    html += mc(m.errors, 'Errors', 'var(--orange)');
    html += mc(m.warnings, 'Warnings', 'var(--yellow)');
    html += mc(m.unread, 'Unread', 'var(--blue)');
    html += mc(m.total, 'Total', 'var(--text)');
    html += '</div></div>';
  });
  html += '</div>';
  document.getElementById('tab-merchants').innerHTML = html;
}

function mc(num, label, color) {
  return '<div class="mc"><div class="num" style="color:' + color + '">' + (num || 0) + '</div><div class="lbl">' + label + '</div></div>';
}

function renderTimeline(timeline) {
  if (!timeline.length) {
    document.getElementById('tab-timeline').innerHTML = '<p class="loading">No timeline data</p>';
    return;
  }
  let html = '<table><thead><tr><th>Time</th><th>Total</th><th>Critical</th><th>Errors</th><th>Warnings</th><th>Info</th></tr></thead><tbody>';
  timeline.slice(-48).forEach(t => {
    const d = new Date(t.bucket);
    const label = d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' + d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
    html += '<tr><td>' + label + '</td>';
    html += '<td>' + t.count + '</td>';
    html += '<td style="color:var(--red)">' + (t.critical || 0) + '</td>';
    html += '<td style="color:var(--orange)">' + (t.errors || 0) + '</td>';
    html += '<td style="color:var(--yellow)">' + (t.warnings || 0) + '</td>';
    html += '<td style="color:var(--blue)">' + (t.info || 0) + '</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('tab-timeline').innerHTML = html;
}

function switchTab(name, btn) {
  ['alerts','merchants','timeline'].forEach(t => {
    document.getElementById('tab-' + t).style.display = t === name ? 'block' : 'none';
  });
  btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
}

function timeAgo(dateStr) {
  const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 60) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
</script>
</body>
</html>`;

export default router;

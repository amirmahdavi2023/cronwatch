/**
 * CronWatch v0.1.0 — serverless dead-man's-switch for cron jobs.
 * One file. Cloudflare Workers + D1 + Cron Trigger. Telegram alerts.
 *
 * Setup:
 *   1. Create a D1 database, bind it to this Worker as `DB`.
 *   2. Set env vars: ADMIN_TOKEN (any secret), TG_BOT_TOKEN, TG_CHAT_ID.
 *   3. Add a Cron Trigger that runs every 5 minutes.
 *   4. Open https://<worker>/?token=<ADMIN_TOKEN>
 *
 * https://github.com/amirmahdavi2023/cronwatch — MIT
 */

const VERSION = "0.1.0";
const PING_HISTORY_LIMIT = 100;

// ---------------------------------------------------------------- schema
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      period_seconds INTEGER NOT NULL,
      grace_seconds INTEGER NOT NULL DEFAULT 3600,
      status TEXT NOT NULL DEFAULT 'new',
      last_ping_at INTEGER,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pings (
      check_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ok'
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pings_check
      ON pings (check_id, received_at DESC)`),
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------- helpers
const now = () => Math.floor(Date.now() / 1000);

function ago(ts) {
  if (!ts) return "never";
  const s = now() - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8", ...headers },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sendTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    return { ok: false, error: "TG_BOT_TOKEN or TG_CHAT_ID not set" };
  }
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TG_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    const data = await r.json();
    return { ok: !!data.ok, error: data.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function isAuthed(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const url = new URL(request.url);
  if (url.searchParams.get("token") === env.ADMIN_TOKEN) return true;
  const cookie = request.headers.get("cookie") || "";
  return cookie.includes(`cw_token=${env.ADMIN_TOKEN}`);
}

// ---------------------------------------------------------------- fetch
export default {
  async fetch(request, env, ctx) {
    if (!env.DB) return html(setupPage("D1 database is not bound as <code>DB</code>."));
    if (!env.ADMIN_TOKEN) return html(setupPage("Env var <code>ADMIN_TOKEN</code> is not set."));
    await ensureSchema(env.DB);

    const url = new URL(request.url);
    const path = url.pathname;

    // --- public: heartbeat ping
    let m = path.match(/^\/ping\/([0-9a-f-]{36})(\/fail|\/start)?$/);
    if (m) return handlePing(env, ctx, m[1], m[2]);

    // --- public: status page + badge
    m = path.match(/^\/status\/([0-9a-f-]{36})$/);
    if (m) return statusPage(env, m[1]);
    m = path.match(/^\/badge\/([0-9a-f-]{36})\.svg$/);
    if (m) return badgeSvg(env, m[1]);

    // --- everything below needs auth
    if (!isAuthed(request, env)) {
      return html(loginPage(), 401);
    }
    const authCookie = {
      "set-cookie": `cw_token=${env.ADMIN_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    };

    if (path === "/" && request.method === "GET") {
      return dashboard(env, url, authCookie);
    }
    if (path === "/api/checks" && request.method === "POST") {
      return createCheck(env, request);
    }
    m = path.match(/^\/api\/checks\/([0-9a-f-]{36})\/(delete|pause|resume)$/);
    if (m && request.method === "POST") {
      return mutateCheck(env, m[1], m[2]);
    }
    if (path === "/api/test-alert" && request.method === "POST") {
      const r = await sendTelegram(env,
        `🔔 <b>CronWatch test alert</b>\nIf you can read this, alerts are working.`);
      return redirect(r.ok ? "/?msg=Test+alert+sent" : `/?msg=Alert+failed:+${encodeURIComponent(r.error || "unknown")}`);
    }
    return html("Not found", 404);
  },

  // -------------------------------------------------------------- cron
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    const t = now();
    const { results } = await env.DB
      .prepare(`SELECT * FROM checks WHERE status IN ('up','late')`)
      .all();

    for (const c of results || []) {
      const deadline = c.last_ping_at + c.period_seconds;
      const hardDeadline = deadline + c.grace_seconds;
      let next = c.status;
      if (t > hardDeadline) next = "down";
      else if (t > deadline) next = "late";
      else next = "up";

      if (next !== c.status) {
        await env.DB
          .prepare(`UPDATE checks SET status = ? WHERE id = ?`)
          .bind(next, c.id).run();
        if (next === "down") {
          ctx.waitUntil(sendTelegram(env,
            `🔴 <b>${esc(c.name)} is DOWN</b>\n` +
            `Last ping: ${ago(c.last_ping_at)}\n` +
            `Expected every ${fmtPeriod(c.period_seconds)} (+${fmtPeriod(c.grace_seconds)} grace)`));
        }
      }
    }

    // prune ping history
    ctx.waitUntil(env.DB.prepare(`
      DELETE FROM pings WHERE rowid IN (
        SELECT p.rowid FROM pings p
        WHERE p.rowid NOT IN (
          SELECT p2.rowid FROM pings p2
          WHERE p2.check_id = p.check_id
          ORDER BY p2.received_at DESC LIMIT ${PING_HISTORY_LIMIT}
        )
      )`).run());
  },
};

// ---------------------------------------------------------------- handlers
async function handlePing(env, ctx, id, suffix) {
  const kind = suffix === "/fail" ? "fail" : suffix === "/start" ? "start" : "ok";
  const c = await env.DB.prepare(`SELECT * FROM checks WHERE id = ?`).bind(id).first();
  if (!c) return json({ ok: false, error: "unknown check" }, 404);

  const t = now();
  const stmts = [
    env.DB.prepare(`INSERT INTO pings (check_id, received_at, kind) VALUES (?,?,?)`)
      .bind(id, t, kind),
  ];
  if (kind === "ok") {
    stmts.push(env.DB.prepare(
      `UPDATE checks SET last_ping_at = ?, status = 'up' WHERE id = ?`).bind(t, id));
  } else if (kind === "fail") {
    stmts.push(env.DB.prepare(
      `UPDATE checks SET last_ping_at = ?, status = 'down' WHERE id = ?`).bind(t, id));
  }
  await env.DB.batch(stmts);

  if (kind === "ok" && c.status === "down") {
    ctx.waitUntil(sendTelegram(env, `🟢 <b>${esc(c.name)} recovered</b>\nPing received just now.`));
  }
  if (kind === "fail" && c.status !== "down") {
    ctx.waitUntil(sendTelegram(env, `🔴 <b>${esc(c.name)} reported FAILURE</b>\nThe job itself signaled /fail.`));
  }
  return json({ ok: true });
}

async function createCheck(env, request) {
  const form = await request.formData();
  const name = (form.get("name") || "").trim();
  const period = parsePeriod(form.get("period"));
  const grace = parsePeriod(form.get("grace")) || 3600;
  if (!name || !period) return redirect("/?msg=Name+and+a+valid+period+are+required");
  await env.DB.prepare(
    `INSERT INTO checks (id, name, period_seconds, grace_seconds, created_at)
     VALUES (?,?,?,?,?)`)
    .bind(crypto.randomUUID(), name, period, grace, now()).run();
  return redirect("/");
}

async function mutateCheck(env, id, action) {
  if (action === "delete") {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM checks WHERE id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM pings WHERE check_id = ?`).bind(id),
    ]);
  } else if (action === "pause") {
    await env.DB.prepare(`UPDATE checks SET status = 'paused' WHERE id = ?`).bind(id).run();
  } else if (action === "resume") {
    await env.DB.prepare(
      `UPDATE checks SET status = CASE WHEN last_ping_at IS NULL THEN 'new' ELSE 'up' END
       WHERE id = ?`).bind(id).run();
  }
  return redirect("/");
}

function redirect(to) {
  return new Response(null, { status: 303, headers: { location: to } });
}

function parsePeriod(v) {
  if (!v) return 0;
  const m = String(v).trim().match(/^(\d+)\s*(m|h|d)?$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const mult = { m: 60, h: 3600, d: 86400 }[(m[2] || "m").toLowerCase()];
  return n * mult;
}

function fmtPeriod(s) {
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  return `${Math.round(s / 60)}m`;
}

// ---------------------------------------------------------------- badge
async function badgeSvg(env, id) {
  const c = await env.DB.prepare(`SELECT * FROM checks WHERE id = ?`).bind(id).first();
  const status = c ? c.status : "unknown";
  const colors = { up: "#2ea043", late: "#d29922", down: "#f85149", paused: "#8b949e", new: "#8b949e", unknown: "#8b949e" };
  const icons = { up: "✓", late: "…", down: "✗", paused: "‖", new: "?", unknown: "?" };
  const label = c ? esc(c.name) : "check";
  const value = c ? `${icons[status]} ${status} · ${ago(c.last_ping_at)}` : "not found";
  const lw = 7 * label.length + 12, vw = 7 * value.length + 12;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${label}: ${value}">
<rect width="${lw}" height="20" fill="#30363d"/>
<rect x="${lw}" width="${vw}" height="20" fill="${colors[status]}"/>
<g fill="#fff" font-family="ui-monospace,monospace" font-size="11">
<text x="6" y="14">${label}</text><text x="${lw + 6}" y="14">${value}</text>
</g></svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=300",
    },
  });
}

// ---------------------------------------------------------------- pages
const CSS = `
:root{--bg:#0b0e14;--panel:#12161f;--line:#1f2530;--text:#c9d1d9;--dim:#8b949e;
--up:#2ea043;--late:#d29922;--down:#f85149;--accent:#3fb950}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
padding:20px;max-width:760px;margin:0 auto}
h1{font-size:16px;letter-spacing:.08em;text-transform:uppercase}
h1 .v{color:var(--dim);font-weight:400;font-size:12px}
.sub{color:var(--dim);font-size:12px;margin:2px 0 20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:10px}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.grow{flex:1;min-width:160px}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.dot.up{background:var(--up);animation:pulse 2.4s ease-in-out infinite}
.dot.late{background:var(--late)}
.dot.down{background:var(--down)}
.dot.new,.dot.paused{background:var(--dim)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(63,185,80,.5)}55%{box-shadow:0 0 0 7px rgba(63,185,80,0)}}
@media (prefers-reduced-motion:reduce){.dot.up{animation:none}}
.name{font-weight:700}
.meta{color:var(--dim);font-size:12px}
code,.url{background:#0d1117;border:1px solid var(--line);border-radius:5px;padding:2px 7px;
font-size:12px;color:var(--dim);word-break:break-all}
button,.btn{background:transparent;border:1px solid var(--line);color:var(--text);border-radius:6px;
padding:5px 11px;font:inherit;font-size:12px;cursor:pointer}
button:hover,.btn:hover{border-color:var(--accent);color:var(--accent)}
button.primary{border-color:var(--accent);color:var(--accent)}
input{background:#0d1117;border:1px solid var(--line);color:var(--text);border-radius:6px;
padding:7px 10px;font:inherit;width:100%}
label{font-size:11px;color:var(--dim);display:block;margin:8px 0 3px;text-transform:uppercase;letter-spacing:.06em}
form.inline{display:inline}
.msg{border:1px solid var(--late);color:var(--late);border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px}
a{color:var(--accent);text-decoration:none}
.empty{color:var(--dim);text-align:center;padding:34px 0}
.foot{color:var(--dim);font-size:11px;margin-top:24px;text-align:center}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}
<p class="foot">CronWatch v${VERSION} — single-file heartbeat monitor · <a href="https://github.com/amirmahdavi2023/cronwatch">GitHub</a></p>
</body></html>`;
}

function setupPage(problem) {
  return page("CronWatch — setup", `
<h1>CronWatch <span class="v">setup needed</span></h1>
<div class="card">
<p>${problem}</p>
<label>To finish setup</label>
<p class="meta">1. Workers dashboard → Settings → Bindings → add D1 database as <code>DB</code><br>
2. Settings → Variables → add <code>ADMIN_TOKEN</code>, <code>TG_BOT_TOKEN</code>, <code>TG_CHAT_ID</code><br>
3. Settings → Triggers → Cron Trigger <code>*/5 * * * *</code><br>
4. Reload this page.</p>
</div>`);
}

function loginPage() {
  return page("CronWatch — sign in", `
<h1>CronWatch</h1>
<div class="card">
<form method="GET" action="/">
<label for="token">Admin token</label>
<input id="token" name="token" type="password" autofocus>
<br><br><button class="primary">Open dashboard</button>
</form></div>`);
}

async function dashboard(env, url, headers) {
  const { results } = await env.DB
    .prepare(`SELECT * FROM checks ORDER BY created_at DESC`).all();
  const origin = url.origin;
  const msg = url.searchParams.get("msg");

  const rows = (results || []).map((c) => `
<div class="card">
  <div class="row">
    <span class="dot ${c.status}"></span>
    <div class="grow">
      <div class="name">${esc(c.name)} <span class="meta">· ${c.status}</span></div>
      <div class="meta">every ${fmtPeriod(c.period_seconds)} +${fmtPeriod(c.grace_seconds)} grace · last ping ${ago(c.last_ping_at)}</div>
    </div>
    ${c.status === "paused"
      ? `<form class="inline" method="POST" action="/api/checks/${c.id}/resume"><button>Resume</button></form>`
      : `<form class="inline" method="POST" action="/api/checks/${c.id}/pause"><button>Pause</button></form>`}
    <form class="inline" method="POST" action="/api/checks/${c.id}/delete"
      onsubmit="return confirm('Delete ${esc(c.name)}?')"><button>Delete</button></form>
  </div>
  <label>Ping URL — add to the end of your job</label>
  <span class="url">curl -fsS ${origin}/ping/${c.id}</span>
  <label>Badge / status</label>
  <span class="meta"><a href="/badge/${c.id}.svg">badge.svg</a> · <a href="/status/${c.id}">public status page</a></span>
</div>`).join("");

  return html(page("CronWatch", `
<h1>CronWatch <span class="v">v${VERSION}</span></h1>
<p class="sub">Alerts when a job that should have run — didn't.</p>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
${rows || `<div class="card empty">No checks yet. Add your first one below.</div>`}
<div class="card">
  <form method="POST" action="/api/checks">
    <label for="n">Job name</label>
    <input id="n" name="name" placeholder="nightly-backup" required>
    <div class="row">
      <div class="grow"><label for="p">Expected every (e.g. 30m, 12h, 1d)</label>
      <input id="p" name="period" placeholder="1d" required></div>
      <div class="grow"><label for="g">Grace (default 1h)</label>
      <input id="g" name="grace" placeholder="1h"></div>
    </div>
    <br><button class="primary">Add check</button>
  </form>
</div>
<form method="POST" action="/api/test-alert"><button>Send test alert to Telegram</button></form>`),
  200, headers);
}

async function statusPage(env, id) {
  const c = await env.DB.prepare(`SELECT * FROM checks WHERE id = ?`).bind(id).first();
  if (!c) return html(page("Not found", `<h1>CronWatch</h1><div class="card empty">Check not found.</div>`), 404);
  const { results } = await env.DB
    .prepare(`SELECT * FROM pings WHERE check_id = ? ORDER BY received_at DESC LIMIT 20`)
    .bind(id).all();
  const hist = (results || []).map((p) =>
    `<div class="meta">${p.kind === "ok" ? "🟢" : p.kind === "fail" ? "🔴" : "▶"} ${new Date(p.received_at * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC</div>`).join("");
  return html(page(`${c.name} — status`, `
<h1>CronWatch <span class="v">status</span></h1>
<div class="card">
  <div class="row"><span class="dot ${c.status}"></span>
  <div class="grow"><div class="name">${esc(c.name)}</div>
  <div class="meta">${c.status} · last ping ${ago(c.last_ping_at)} · expected every ${fmtPeriod(c.period_seconds)}</div></div></div>
</div>
<div class="card"><label>Recent pings</label>${hist || `<div class="meta">No pings yet.</div>`}</div>`),
  200, { "cache-control": "public, max-age=60" });
}

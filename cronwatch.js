// ============================================================================
// CronWatch v0.2.0
// Zero-instrumentation cron monitoring for Cloudflare Workers.
//
// Cloudflare won't tell you when your cron dies. This single-file Worker will —
// without changing a single line in your existing Workers.
//
// How it works:
//   Every 5 minutes it reads the official GraphQL Analytics dataset
//   `workersInvocationsScheduled` (cron runs only), learns each cron's
//   normal interval from its *scheduled* times, and sends a Telegram alert
//   when a cron misses its schedule or a run fails. Sends a recovery
//   message when the cron comes back.
//
// ---------------------------------------------------------------------------
// SETUP (dashboard only, ~10 minutes):
//
// 1. Create a KV namespace:
//    Storage & Databases -> KV -> Create namespace -> name: CRONWATCH
//
// 2. Workers & Pages -> Create Worker -> name: cronwatch -> paste this file.
//
// 3. Worker -> Settings -> Bindings -> Add -> KV Namespace:
//      Variable name: CRONWATCH_KV   Namespace: CRONWATCH
//
// 4. Worker -> Settings -> Variables and Secrets:
//      CF_API_TOKEN  (Secret)  API token with ONLY "Account Analytics: Read"
//      CF_ACCOUNT_ID (Text)    your account ID
//      TG_BOT_TOKEN  (Secret)  Telegram bot token from @BotFather
//      TG_CHAT_ID    (Text)    your chat id (send a msg to your bot, then
//                              open api.telegram.org/bot<TOKEN>/getUpdates)
//    Optional overrides:
//      BUFFER_SECONDS  default 180  (ingest delay + safety margin;
//                                    auto-scales to 5% of the interval
//                                    for infrequent crons)
//      MIN_RUNS        default 3    (grace: runs required before arming)
//      WINDOW_HOURS    default 6    (analytics lookback per check)
//      WATCH           comma-separated script names to watch (default: all)
//      EXCLUDE         comma-separated script names to ignore
//      WORKER_NAME     this worker's own script name if you didn't call it
//                      "cronwatch" (it always excludes itself)
//
// 5. Worker -> Settings -> Triggers -> Add Cron Trigger:  */5 * * * *
//
// 6. Open https://<worker-url>/test  -> you should get a Telegram message.
//    Open https://<worker-url>/run   -> first check, then /status.
//
// Note on WINDOW_HOURS: it does NOT need to exceed your longest cron
// interval. Checks run every 5 minutes, so every invocation lands inside
// many overlapping windows; state (and missed-run detection) persists in KV.
// The window only needs to cover potential downtime of CronWatch itself.
// ============================================================================

const GQL = "https://api.cloudflare.com/client/v4/graphql";
const STATE_KEY = "cronwatch:state";
const PRUNE_AFTER_DAYS = 7;   // floor; actual prune = max(this, 3x interval)
const DIGEST_THRESHOLD = 3;   // >N alerts in one check -> single digest message

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cfg(env) {
  const self = (env.WORKER_NAME || "cronwatch").trim();
  const exclude = (env.EXCLUDE || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!exclude.includes(self)) exclude.push(self);
  return {
    bufferSeconds: parseInt(env.BUFFER_SECONDS || "180", 10),
    minRuns: parseInt(env.MIN_RUNS || "3", 10),
    windowHours: parseInt(env.WINDOW_HOURS || "6", 10),
    watch: (env.WATCH || "").split(",").map((s) => s.trim()).filter(Boolean),
    exclude,
  };
}

function isWatched(scriptName, conf) {
  if (conf.exclude.includes(scriptName)) return false;
  if (conf.watch.length && !conf.watch.includes(scriptName)) return false;
  return true;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// buffer grows with the interval so daily/weekly crons aren't flagged
// for being a couple of minutes late
function effectiveBuffer(bufferSeconds, med) {
  return Math.max(bufferSeconds, Math.round((med || 0) * 0.05));
}

function fmtDur(seconds) {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

async function gql(env, query, variables) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.CF_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

async function sendTelegram(env, text) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text }),
    },
  );
  const j = await r.json().catch(() => ({}));
  return j.ok === true;
}

async function loadState(env) {
  try {
    const s = await env.CRONWATCH_KV.get(STATE_KEY, "json");
    return s && typeof s === "object" && s.crons ? s : { crons: {} };
  } catch {
    return { crons: {} };
  }
}

async function saveState(env, state) {
  await env.CRONWATCH_KV.put(STATE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// analytics
// ---------------------------------------------------------------------------

async function fetchScheduledRuns(env, windowHours) {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const query = `
query($account: String!, $since: String!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsScheduled(
        limit: 1000,
        filter: { datetime_geq: $since }
      ) {
        scriptName
        cron
        datetime
        scheduledDatetime
        status
      }
    }
  }
}`;
  const res = await gql(env, query, { account: env.CF_ACCOUNT_ID, since });
  if (res.errors) throw new Error("GraphQL: " + JSON.stringify(res.errors));
  return res.data?.viewer?.accounts?.[0]?.workersInvocationsScheduled ?? [];
}

// ---------------------------------------------------------------------------
// core check
// ---------------------------------------------------------------------------

async function runCheck(env) {
  const conf = cfg(env);
  const { bufferSeconds, minRuns, windowHours } = conf;
  const now = Date.now();
  const state = await loadState(env);
  const alerts = [];

  let rows;
  try {
    rows = await fetchScheduledRuns(env, windowHours);
  } catch (e) {
    // Analytics itself failing: count consecutive failures, warn once at 3.
    state.apiFailures = (state.apiFailures || 0) + 1;
    if (state.apiFailures === 3) {
      alerts.push(
        "⚠️ CronWatch: can't reach Cloudflare Analytics (3 checks in a row). " +
        "Monitoring is blind until this recovers. Last error: " + String(e).slice(0, 200),
      );
    }
    await dispatch(env, alerts);
    await saveState(env, state);
    return { ok: false, error: String(e) };
  }

  if (state.apiFailures >= 3) {
    alerts.push("✅ CronWatch: connection to Cloudflare Analytics restored.");
  }
  state.apiFailures = 0;

  // group rows by (scriptName, cron)
  // Skip "__unknown__": Analytics uses it for freshly created Workers until
  // their name resolves (observed: up to ~3h). Tracking it causes a phantom
  // "missed schedule" alert the moment the real name appears. The worker is
  // picked up under its real name, with a clean grace period, once resolved.
  const groups = {};
  for (const r of rows) {
    if (r.scriptName === "__unknown__") continue;
    if (!isWatched(r.scriptName, conf)) continue;
    const key = r.scriptName + " ⏰ " + r.cron;
    (groups[key] ??= []).push(r);
  }

  // update every group we saw
  for (const [key, list] of Object.entries(groups)) {
    const st = (state.crons[key] ??= {
      lastSeen: 0, samples: [], runCount: 0,
      alerted: false, alertedAt: 0, lastFailureSeen: 0,
    });

    // interval learning uses the *scheduled* times: noise-free cadence
    const times = [...new Set(list.map((r) => Date.parse(r.scheduledDatetime)))]
      .sort((a, b) => a - b);
    const newTimes = times.filter((t) => t > st.lastSeen);

    const seq = st.lastSeen ? [st.lastSeen, ...newTimes] : newTimes;
    for (let i = 1; i < seq.length; i++) {
      st.samples.push(Math.round((seq[i] - seq[i - 1]) / 1000));
    }
    if (st.samples.length > 20) st.samples = st.samples.slice(-20);
    st.runCount += newTimes.length;

    if (newTimes.length) {
      const prevLastSeen = st.lastSeen;
      st.lastSeen = newTimes[newTimes.length - 1];

      // recovery?
      if (st.alerted) {
        const med = median(st.samples);
        const gap = prevLastSeen
          ? Math.round((st.lastSeen - prevLastSeen) / 1000)
          : null;
        const downtime = gap && med ? Math.max(0, gap - med) : gap;
        alerts.push(
          `✅ CronWatch: ${key} is running again` +
          (downtime ? ` (was down ~${fmtDur(downtime)})` : "") + ".",
        );
        st.alerted = false;
        st.alertedAt = 0;
      }
    }

    // failures (any non-success status), dedup by actual run datetime
    const failures = list
      .filter((r) => r.status !== "success" && Date.parse(r.datetime) > st.lastFailureSeen)
      .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
    if (failures.length) {
      st.lastFailureSeen = Date.parse(failures[failures.length - 1].datetime);
      const statuses = [...new Set(failures.map((f) => f.status))].join(", ");
      alerts.push(
        `⚠️ CronWatch: ${key} had ${failures.length} failed run(s) ` +
        `(status: ${statuses}), last at ${failures[failures.length - 1].datetime}.`,
      );
    }
  }

  // missed-run detection over ALL known crons (including ones absent from window)
  for (const [key, st] of Object.entries(state.crons)) {
    // config may have changed since this cron entered state: honor it
    const script = key.split(" ⏰ ")[0];
    if (!isWatched(script, conf)) {
      delete state.crons[key];
      continue;
    }

    const med = median(st.samples);

    // prune long-gone crons (deleted workers) — never before ~3 intervals
    const pruneMs = Math.max(
      PRUNE_AFTER_DAYS * 86400 * 1000,
      med ? 3 * med * 1000 : 0,
    );
    if (st.lastSeen && now - st.lastSeen > pruneMs) {
      delete state.crons[key];
      continue;
    }

    if (st.runCount < minRuns || st.samples.length < 2 || !med) continue; // grace

    const sinceLast = Math.round((now - st.lastSeen) / 1000);
    const buf = effectiveBuffer(bufferSeconds, med);

    if (!st.alerted && sinceLast > med + buf) {
      st.alerted = true;
      st.alertedAt = now;
      alerts.push(
        `🔴 CronWatch: ${key} missed its schedule.\n` +
        `Last run: ${fmtDur(sinceLast)} ago (normally every ~${fmtDur(med)}).`,
      );
    }
  }

  state.lastCheckAt = now;
  await dispatch(env, alerts);
  await saveState(env, state);
  return { ok: true, watched: Object.keys(state.crons).length, alertsSent: alerts.length };
}

async function dispatch(env, alerts) {
  if (!alerts.length) return;
  // avoid Telegram rate limits: many alerts at once -> one digest message
  const messages = alerts.length > DIGEST_THRESHOLD
    ? ["📋 CronWatch digest (" + alerts.length + " events):\n\n" + alerts.join("\n\n")]
    : alerts;
  for (const m of messages) {
    try { await sendTelegram(env, m); } catch (e) { console.log("tg fail:", e); }
  }
}

// ---------------------------------------------------------------------------
// status / test endpoints
// ---------------------------------------------------------------------------

async function statusJson(env) {
  const conf = cfg(env);
  const { bufferSeconds, minRuns } = conf;
  const state = await loadState(env);
  const now = Date.now();
  const out = {};
  for (const [key, st] of Object.entries(state.crons)) {
    const med = median(st.samples);
    const armed = st.runCount >= minRuns && st.samples.length >= 2 && !!med;
    const sinceLast = st.lastSeen ? Math.round((now - st.lastSeen) / 1000) : null;
    const buf = effectiveBuffer(bufferSeconds, med);
    out[key] = {
      lastSeen: st.lastSeen ? new Date(st.lastSeen).toISOString() : null,
      secondsSinceLastRun: sinceLast,
      learnedIntervalSeconds: med,
      medianSamples: st.samples,
      runCount: st.runCount,
      armed,
      alertActive: !!st.alerted,
      alertThresholdSeconds: armed ? med + buf : null,
      secondsUntilAlert: armed && !st.alerted && sinceLast != null
        ? Math.max(0, med + buf - sinceLast)
        : null,
    };
  }

  return {
    cronwatch: "v0.1.0",
    checkedAt: new Date(now).toISOString(),
    lastCheckAt: state.lastCheckAt
      ? new Date(state.lastCheckAt).toISOString()
      : null,
    note: "State updates only when a check runs (every 5 min). " +
      "Per-cron numbers reflect the world as of lastCheckAt, not this page load.",
    config: {
      bufferSeconds, minRuns,
      watch: conf.watch, exclude: conf.exclude,
    },
    apiFailures: state.apiFailures || 0,
    watching: out,
  };
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });

    try {
      if (url.pathname === "/test") {
        const ok = await sendTelegram(
          env,
          "✅ CronWatch test — Telegram wiring works. Monitoring is active.",
        );
        return json({ telegramOk: ok });
      }
      if (url.pathname === "/run") {
        // manual check trigger, useful right after install
        return json(await runCheck(env));
      }
      if (url.pathname === "/status") return json(await statusJson(env));
      return new Response(
        "CronWatch v0.1.0 — endpoints: /status, /test, /run",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  },
};

const ORIGINS = new Set(["https://news.zacai.fun", "http://news.zacai.fun"]);
const API = "/api/news-refresh";
const WORKFLOW =
  "https://api.github.com/repos/ZrBac/news/actions/workflows/news.yml";
const BRANCH = "main";
const HEALTH = "https://news.zacai.fun/data/status.json";
const MANUAL_INTERVAL = 900_000;
const RECOVERY_INTERVAL = 7_200_000;

function timestamp(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("invalid_timestamp");
  return time;
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function boundedText(response, maximum) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error("body_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function coordinator(env) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("news"));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const reply = (body, code = 200) => {
      const response = json(body, code);
      if (ORIGINS.has(origin))
        response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Vary", "Origin");
      response.headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS",
      );
      response.headers.set(
        "Access-Control-Allow-Headers",
        "X-News-Refresh, Content-Type, Authorization",
      );
      response.headers.set("Access-Control-Max-Age", "600");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    };
    const { pathname, search, searchParams } = new URL(request.url);
    const outingRoute = {"/api/outings/profile":"/outing-profile", "/api/outings/journal":"/outing-journal",
      "/api/outings/connect":"/outing-connect"}[pathname];
    const journalVersion = pathname === "/api/outings/journal" && /^\?version=\d{1,15}$/.test(search);
    if (outingRoute && (!search || journalVersion)) {
      if (origin && !ORIGINS.has(origin)) return reply({ status: "forbidden" }, 403);
      if (request.method === "OPTIONS" && ORIGINS.has(origin)) return reply({ status: "ok" });
      const connecting = outingRoute === "/outing-connect";
      if (!connecting && (!env.OUTING_PROFILE_TOKEN || request.headers.get("Authorization") !== "Bearer " + env.OUTING_PROFILE_TOKEN))
        return reply({ status: "unauthorized" }, 401);
      if (!(connecting ? ["POST"] : ["GET", "POST"]).includes(request.method)) return reply({ status: "method_not_allowed" }, 405);
      if (request.method === "POST" && !ORIGINS.has(origin)) return reply({ status: "forbidden" }, 403);
      try {
        const { success } = await env.REQUEST_LIMITER.limit({ key: "outings:" + (request.headers.get("CF-Connecting-IP") || "build") });
        if (!success) return reply({ status: "busy" }, 429);
        let body;
        try { body = request.method === "POST" ? await boundedText(request, connecting ? 128 : 32768) : undefined; }
        catch { return reply({status:"invalid_request"}, 413); }
        const object = env.COORDINATOR.get(env.COORDINATOR.idFromName("outings"));
        const response = await object.fetch(new Request("https://internal" + outingRoute + (journalVersion ? "?version=" + searchParams.get("version") : ""), {
          method: request.method, ...(body !== undefined ? { body } : {}),
          headers: connecting ? {"X-Connect-IP":request.headers.get("CF-Connecting-IP") || "unknown"} : {},
        }));
        return reply(await response.json(), response.status);
      } catch { return reply({ status: "unavailable" }, 503); }
    }
    if (![API, API + "/status"].includes(pathname) || search)
      return reply({ status: "not_found" }, 404);
    if (!ORIGINS.has(origin)) return reply({ status: "forbidden" }, 403);
    if (request.method === "OPTIONS") return reply({ status: "ok" });
    const action =
      request.method === "GET" && pathname === API + "/status"
        ? "status"
        : request.method === "POST" && pathname === API
          ? "trigger"
          : null;
    if (!action) return reply({ status: "method_not_allowed" }, 405);
    try {
      const { success } = await env.REQUEST_LIMITER.limit({
        key: request.headers.get("CF-Connecting-IP") || "unknown",
      });
      if (!success) return reply({ status: "busy", retryAfter: 60 }, 429);
      if (action === "trigger") {
        if (request.headers.get("X-News-Refresh") !== "1")
          return reply({ status: "forbidden" }, 403);
        let body;
        try {
          body = (await boundedText(request, 128)).trim();
        } catch {
          return reply({ status: "invalid_request" }, 413);
        }
        if (body !== "" && body !== "{}")
          return reply({ status: "invalid_request" }, 400);
        if (env.MANUAL_ENABLED !== "true")
          return reply({ status: "unavailable" }, 503);
      }
      const response = await coordinator(env).fetch(
        "https://internal/" + action,
      );
      return reply(await response.json(), response.status);
    } catch {
      console.error(JSON.stringify({ event: "refresh_api_failed" }));
      return reply({ status: "unavailable" }, 503);
    }
  },
  async scheduled(_event, env) {
    if (env.WATCHDOG_ENABLED !== "true") return;
    const response = await coordinator(env).fetch("https://internal/check");
    const result = await response.json();
    console.log(JSON.stringify({ event: "watchdog", ...result }));
    if (!response.ok) throw new Error("watchdog_failed");
  },
};

// One SQLite-backed Durable Object serializes manual and scheduled requests globally.
// Persistent budgets survive restarts; all network calls have bounded deadlines.
export class NewsCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.runsCache = null;
    this.errorUntil = 0;
  }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (Date.now() < this.errorUntil)
          return json({ status: "unavailable" }, 503);
        const action = new URL(request.url).pathname;
        if (action === "/outing-profile") return await this.outingProfile(request);
        if (action === "/outing-connect") return await this.outingConnect(request);
        if (action === "/outing-journal") return await this.outingJournal(request);
        if (action === "/status") return json(await this.status());
        if (action === "/trigger" && this.env.MANUAL_ENABLED === "true")
          return json(await this.trigger());
        if (action === "/check" && this.env.WATCHDOG_ENABLED === "true")
          return json(await this.check());
        return json({ status: "not_found" }, 404);
      } catch {
        // Avoid retry storms on expired credentials or an upstream outage. No secrets in logs.
        this.errorUntil = Date.now() + 10_000;
        console.error(JSON.stringify({ event: "coordinator_failed" }));
        return json({ status: "unavailable" }, 503);
      }
    });
  }

  async outingProfile(request) {
    const profile = await this.ctx.storage.get("outingProfile") || { schema: 1, settings: {}, records: [], updatedAt: null };
    if (request.method === "GET") return json(profile);
    let input;
    try { input = JSON.parse(await boundedText(request, 8192)); }
    catch { return json({ status: "invalid_request" }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json({ status: "invalid_request" }, 400);
    const stamp = new Date().toISOString();
    if (input.action === "settings") {
      if (typeof input.startArea !== "string" || input.startArea.length > 50 ||
          !Number.isInteger(input.people) || input.people < 1 || input.people > 10 ||
          !["car", "transit"].includes(input.transport)) return json({ status: "invalid_request" }, 400);
      profile.settings = { startArea: input.startArea.trim(), people: input.people, transport: input.transport };
    } else if (["record", "remove"].includes(input.action)) {
      if (typeof input.id !== "string" || !/^(place|event):[a-z0-9-]{1,100}$/.test(input.id))
        return json({ status: "invalid_request" }, 400);
      if (input.action === "record") {
        if (!["visited", "want", "dismiss"].includes(input.status) || typeof input.title !== "string" ||
            !input.title.trim() || input.title.length > 150) return json({ status: "invalid_request" }, 400);
        const record = { id: input.id, title: input.title.trim(), status: input.status, updatedAt: stamp };
        profile.records = [record, ...profile.records.filter(r => r.id !== input.id)].slice(0, 300);
      } else profile.records = profile.records.filter(r => r.id !== input.id);
    } else return json({ status: "invalid_request" }, 400);
    profile.updatedAt = stamp;
    await this.ctx.storage.put("outingProfile", profile);
    return json(profile);
  }

  async outingConnect(request) {
    if (!/^\d{6}$/.test(this.env.OUTING_PAIRING_PIN || "") || !this.env.OUTING_PROFILE_TOKEN)
      return json({status:"unavailable"}, 503);
    let input;
    try { input = JSON.parse(await boundedText(request, 128)); }
    catch { return json({status:"invalid_request"}, 400); }
    if (!input || typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
      return json({status:"invalid_request"}, 400);
    const now = Date.now(), interval = 900000, ip = request.headers.get("X-Connect-IP") || "unknown";
    let attempts = await this.ctx.storage.get("outingConnectAttempts");
    if (!attempts || now - attempts.start >= interval) attempts = {start:now, total:0, ips:{}};
    if (attempts.total >= 30 || (attempts.ips[ip] || 0) >= 5)
      return json({status:"busy", retryAfter:Math.ceil((attempts.start + interval - now) / 1000)}, 429);
    attempts.total++; attempts.ips[ip] = (attempts.ips[ip] || 0) + 1;
    await this.ctx.storage.put("outingConnectAttempts", attempts);
    let difference = 0;
    for (let i = 0; i < 6; i++) difference |= input.code.charCodeAt(i) ^ this.env.OUTING_PAIRING_PIN.charCodeAt(i);
    if (difference) return json({status:"unauthorized"}, 401);
    // The short pairing code is exchanged once; subsequent requests use the
    // existing high-entropy credential. Neither is part of any public build.
    return json({token:this.env.OUTING_PROFILE_TOKEN});
  }

  async outingJournal(request) {
    const storage = this.ctx.storage;
    const meta = await storage.get("journalMeta") || {version:0, count:0};
    if (request.method === "GET") {
      const version = new URL(request.url).searchParams.get("version");
      if (version !== null && Number(version) === meta.version)
        return json({schema:1, version:meta.version, unchanged:true});
      const records = [];
      let startAfter;
      do {
        const page = await storage.list({prefix:"journal-entry:", limit:500, ...(startAfter ? {startAfter} : {})});
        for (const [key, entry] of page) {
          if (!entry.deleted) records.push(entry);
          startAfter = key;
        }
        if (page.size < 500) break;
      } while (true);
      records.sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return json({schema:1, version:meta.version, records});
    }
    let input;
    try { input = JSON.parse(await boundedText(request, 32768)); }
    catch { return json({status:"invalid_request"}, 400); }
    const idValid = id => typeof id === "string" && /^evening-[a-f0-9]{24}$/.test(id);
    const recordValid = r => r && idValid(r.id) && /^event:tonight-[a-z0-9-]{1,70}$/.test(r.activityId) &&
      typeof r.title === "string" && r.title.trim() && r.title.length <= 80 &&
      typeof r.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(r.createdAt) && Number.isFinite(Date.parse(r.createdAt)) &&
      typeof r.note === "string" && r.note.trim() && r.note.length <= 500 && typeof r.next === "string" && r.next.length <= 200;
    const ops = input?.operations;
    if (input?.schema !== 1 || !Array.isArray(ops) || !ops.length || ops.length > 10 ||
        !ops.every(op => op && typeof op.id === "string" && /^op-[a-f0-9]{24}$/.test(op.id) &&
          (op.action === "put" ? recordValid(op.record) : op.action === "remove" && idValid(op.recordId))) ||
        new Set(ops.map(op => op.id)).size !== ops.length) return json({status:"invalid_request"}, 400);
    const writes = {}, acknowledged = [];
    for (const op of ops) {
      acknowledged.push(op.id);
      const receipt = "journal-op:" + op.id;
      if (await storage.get(receipt)) continue;
      const key = "journal-entry:" + (op.action === "put" ? op.record.id : op.recordId);
      const previous = writes[key] || await storage.get(key);
      if (op.action === "put" && (!previous || previous.deleted)) {
        if (meta.count >= 2000) return json({status:"journal_full"}, 409);
        const r = op.record;
        writes[key] = {id:r.id, activityId:r.activityId, title:r.title, createdAt:r.createdAt, note:r.note, next:r.next};
        meta.count++; meta.version++;
      } else if (op.action === "remove" && previous && !previous.deleted) {
        writes[key] = {deleted:true}; meta.count--; meta.version++;
      }
      writes[receipt] = true;
    }
    // Save individual small entries, receipts and the revision in one atomic
    // write. A lost response can be retried without resurrecting a deletion.
    await storage.put({...writes, journalMeta:meta});
    return json({schema:1, version:meta.version, acknowledged});
  }

  async upstream(url, options = {}, maximum = 300_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url, {
        ...options,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("upstream_failed");
      const body = await boundedText(response, maximum);
      return body ? JSON.parse(body) : null;
    } finally {
      clearTimeout(timeout);
    }
  }

  github(path, options = {}) {
    if (!this.env.GITHUB_TOKEN) throw new Error("missing_secret");
    return this.upstream(WORKFLOW + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "NewsRefreshWorker",
        "Content-Type": "application/json",
      },
    });
  }

  async runs() {
    if (this.runsCache && Date.now() - this.runsCache.at < 10_000)
      return this.runsCache.runs;
    const data = await this.github(`/runs?branch=${BRANCH}&per_page=20`);
    if (!Array.isArray(data?.workflow_runs)) throw new Error("invalid_runs");
    const runs = data.workflow_runs.map((r) => {
      if (!Number.isSafeInteger(r.id) || typeof r.status !== "string")
        throw new Error("invalid_run");
      return {
        id: r.id,
        status: r.status,
        conclusion: r.conclusion,
        created: timestamp(r.created_at),
      };
    });
    runs.sort((a, b) => b.created - a.created);
    this.runsCache = { at: Date.now(), runs };
    return runs;
  }

  async published() {
    const data = await this.upstream(
      HEALTH + "?health=" + Date.now(),
      {
        headers: { "Cache-Control": "no-cache" },
      },
      4096,
    );
    const updated = timestamp(data?.updatedAt);
    if (updated > Date.now() + 600_000) throw new Error("future_publication");
    return data.updatedAt;
  }

  async status() {
    const runs = await this.runs();
    const state = await this.ctx.storage.get("request");
    const active = runs.find((r) => r.status !== "completed");
    if (active)
      return {
        status: "running",
        runId: active.id,
        baselineAt: state?.baselineAt,
      };
    if (!state) return { status: "idle" };
    // A timed-out dispatch can still succeed; discover the eventual run by creation time.
    const run = runs.find((r) => r.created >= state.requestedAt - 5000);
    if (run)
      return {
        status: run.conclusion === "success" ? "ready" : "failed",
        runId: run.id,
        baselineAt: state.baselineAt,
      };
    return {
      status: Date.now() - state.requestedAt < 120_000 ? "running" : "failed",
      baselineAt: state.baselineAt,
    };
  }

  async dispatch(baselineAt, state) {
    const now = Date.now();
    // Persist every budget before issuing a request which may succeed despite a timeout.
    const values = { request: { requestedAt: now, baselineAt } };
    if (state) values.recovery = state;
    await this.ctx.storage.put(values);
    this.runsCache = null;
    await this.github("/dispatches", {
      method: "POST",
      body: JSON.stringify({ ref: BRANCH }),
    });
    return { status: "running", baselineAt };
  }

  async trigger() {
    const now = Date.now();
    const runs = await this.runs();
    const active = runs.find((r) => r.status !== "completed");
    if (active) return { status: "running", runId: active.id };
    const state = await this.ctx.storage.get("request");
    const recent = Math.max(
      state?.requestedAt || 0,
      ...runs.map((r) => r.created),
    );
    if (now - recent < MANUAL_INTERVAL)
      return {
        status: "cooldown",
        retryAfter: Math.ceil((MANUAL_INTERVAL - now + recent) / 1000),
      };
    const baselineAt = await this.published();
    if (now - timestamp(baselineAt) < MANUAL_INTERVAL)
      return { status: "fresh", updatedAt: baselineAt };
    return this.dispatch(baselineAt);
  }

  async check() {
    const now = Date.now();
    const baselineAt = await this.published();
    const updated = timestamp(baselineAt);
    let state = await this.ctx.storage.get("recovery");
    if (state && updated < timestamp(state.baselineAt))
      return { status: "older_cached_response" };
    if (!state || updated > timestamp(state.baselineAt))
      state = { baselineAt, attempts: [] };
    state.attempts = state.attempts.filter((t) => t > now - 86_400_000);
    await this.ctx.storage.put("recovery", state);
    if (now - updated <= RECOVERY_INTERVAL)
      return { status: "fresh", updatedAt: baselineAt };
    const runs = await this.runs();
    if (runs.some((r) => r.status !== "completed"))
      return { status: "run_active" };
    const manual = await this.ctx.storage.get("request");
    const recent = Math.max(
      manual?.requestedAt || 0,
      ...state.attempts,
      ...runs.map((r) => r.created),
    );
    if (now - recent < RECOVERY_INTERVAL) return { status: "cooldown" };
    if (state.attempts.length >= 3) return { status: "retry_limit" };
    state.attempts.push(now);
    await this.dispatch(baselineAt, state);
    return {
      status: "dispatched",
      updatedAt: baselineAt,
      attempts: state.attempts.length,
    };
  }
}

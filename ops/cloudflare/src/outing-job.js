import {bounded, generateAdvice, inputValid, readJSON} from "./outing-now.js";

const RETAIN_MS = 86400000, RUN_MS = 120000;
const json = (body, status = 200) => Response.json(body, {status, headers:{"Cache-Control":"no-store"}});
const canonical = input => JSON.stringify({minutes:input.minutes, setting:input.setting, note:input.note, previous:input.previous});
const view = job => ({schema:1, status:job.status, stage:job.stage,
  startedAt:new Date(job.startedAt).toISOString(), deadline:job.deadline,
  expiresAt:new Date(job.expiresAt).toISOString(), ...(job.result ? {result:job.result} : {})});

// Each opaque client-generated ID names one job. An alarm owns generation, so
// losing the POST response or closing a phone tab does not cancel model work.
// This object is separate from shared feedback and never reads the journal.
export class OutingAdviceJob {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  gate() { return this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("outing-advice")); }
  async release(job) {
    if (!job.lease) return;
    try {
      await bounded(signal => this.gate().fetch(new Request("https://internal/advice-release", {
        method:"POST", body:JSON.stringify({lease:job.lease}), signal,
      })), 5000);
    } catch { /* The bounded lease also expires after an interrupted runtime. */ }
  }

  async fetch(request) {
    // Only the short storage/reservation transaction is serialized. Status
    // polling stays responsive while alarm() awaits the model.
    return this.ctx.blockConcurrencyWhile(async () => {
      let job = await this.ctx.storage.get("job");
      const now = Date.now();
      if (job && now >= job.expiresAt) return json({status:"expired"}, 410);
      if (request.method === "GET") {
        if (!job) return json({status:"not_found"}, 404);
        return json(view(job));
      }
      if (request.method !== "POST") return json({status:"method_not_allowed"}, 405);
      let input;
      try { input = await readJSON(request, 4096); } catch { return json({status:"invalid_request"}, 400); }
      if (!inputValid(input)) return json({status:"invalid_request"}, 400);
      if (job) {
        if (job.fingerprint !== canonical(input)) return json({status:"conflict"}, 409);
        return json(view(job), ["queued","running"].includes(job.status) ? 202 : 200);
      }
      const permit = await bounded(async signal => {
        const response = await this.gate().fetch(new Request("https://internal/advice-acquire", {method:"POST", signal}));
        return {ok:response.ok, body:await readJSON(response)};
      }, 5000);
      if (!permit.ok) return json({status:"busy",retryAfter:30}, 429);
      job = {status:"queued", stage:"preparing", input, fingerprint:canonical(input), lease:permit.body.lease,
        startedAt:now, deadline:now + RUN_MS, expiresAt:now + RETAIN_MS};
      // Persist the job and its wake-up together, before acknowledging it.
      try {
        await this.ctx.storage.transaction(async storage => {
          await storage.put("job", job);
          await storage.setAlarm(now + 1);
        });
      } catch (error) { await this.release(job); throw error; }
      return json(view(job), 202);
    });
  }

  async alarm() {
    const job = await this.ctx.storage.get("job");
    if (!job) return;
    if (Date.now() >= job.expiresAt) { await this.ctx.storage.deleteAll(); return; }
    if (!["queued","running"].includes(job.status)) {
      await this.ctx.storage.setAlarm(job.expiresAt); return;
    }
    const started = Date.now();
    try {
      // Alarms may be redelivered after a crash. Never silently charge for a
      // second generation if the original provider request may have succeeded.
      if (job.status === "running") throw new Error("interrupted");
      if (job.deadline - Date.now() < 10000) throw new Error("timeout");
      job.status = "running";
      await this.ctx.storage.put("job", job);
      await this.ctx.storage.setAlarm(job.deadline + 1000);
      job.result = await generateAdvice(this.env, job.input, Date.now(), {
        timeoutMs:Math.min(90000, job.deadline - Date.now() - 7000),
        onStage:async stage => { job.stage = stage; await this.ctx.storage.put("job", job); },
      });
      job.status = "ok";
    } catch (error) {
      job.status = error.message === "timeout" ? "timeout" : error.message === "upstream_busy" ? "busy" : "unavailable";
      const cause = /^(?:(?:context|model)_http_[1-5]\d\d|context_unavailable|invalid_response|upstream_busy|timeout|interrupted|response_too_large)$/.test(error.message) ? error.message : "internal";
      console.error(JSON.stringify({event:"outing_job_failed",status:job.status,stage:job.stage,cause,durationMs:Date.now()-started}));
    }
    // Save before releasing the permit: fetching the answer must not depend on
    // whether another short call to the coordinator happens to succeed.
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(job.expiresAt);
    await this.release(job);
    if (job.status === "ok") console.log(JSON.stringify({event:"outing_job_completed",durationMs:Date.now()-started}));
  }
}

/** Durable, account-wide MangaDex@Home report queue. It serializes all reports
 * across isolates and enforces a conservative 6.1-second minimum start interval.
 * Accepted reservations survive restarts. Uncompleted retrievals become failures.
 */
type Stats = { url: string; success: boolean; cached: boolean; bytes: number; duration: number };
type Job = { id: string; created: number; ready: boolean; attempts: number; stats: Stats };
const MAX_PENDING = 500;
const INTERVAL = 6100;

export class ReportQueue {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    const input = await request.json<{ id?: string; url?: string; success?: boolean; cached?: boolean; bytes?: number; duration?: number }>();
    return this.state.blockConcurrencyWhile(async () => {
      const jobs = (await this.state.storage.get<Job[]>("jobs")) ?? [];
      if (path === "/reserve") {
        if (jobs.length >= MAX_PENDING) { console.error("MangaDex report queue is full"); return new Response(null, { status: 503 }); }
        if (typeof input.url !== "string" || input.url.length > 2048) return new Response(null, { status: 400 });
        const job: Job = { id: crypto.randomUUID(), created: Date.now(), ready: false, attempts: 0,
          stats: { url: input.url, success: false, cached: false, bytes: 0, duration: 0 } };
        jobs.push(job);
        await this.state.storage.put("jobs", jobs);
        await this.schedule(jobs);
        return Response.json({ id: job.id });
      }
      if (path === "/complete") {
        const job = jobs.find(x => x.id === input.id);
        if (!job) return new Response(null, { status: 404 });
        if (typeof input.success !== "boolean" || typeof input.cached !== "boolean" ||
            typeof input.bytes !== "number" || !Number.isFinite(input.bytes) || input.bytes < 0 ||
            typeof input.duration !== "number" || !Number.isFinite(input.duration) || input.duration < 0)
          return new Response(null, { status: 400 });
        job.stats = { url: job.stats.url, success: input.success, cached: input.cached, bytes: input.bytes, duration: input.duration };
        job.ready = true;
        await this.state.storage.put("jobs", jobs);
        await this.schedule(jobs);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
  }

  private async schedule(jobs: Job[]): Promise<void> {
    if (!jobs.length) return;
    const now = Date.now();
    const next = (await this.state.storage.get<number>("next")) ?? now;
    const readyAt = jobs.some(x => x.ready) ? now : Math.min(...jobs.map(x => x.created + 20_000));
    const target = Math.max(now + 10, next, readyAt);
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > target) await this.state.storage.setAlarm(target);
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const jobs = (await this.state.storage.get<Job[]>("jobs")) ?? [];
      if (!jobs.length) return;
      const now = Date.now();
      const next = (await this.state.storage.get<number>("next")) ?? 0;
      if (next > now) { await this.state.storage.setAlarm(next); return; }
      const job = jobs.find(x => x.ready || now - x.created >= 20_000);
      if (!job) { await this.state.storage.setAlarm(Math.min(...jobs.map(x => x.created + 20_000))); return; }
      if (!job.ready) job.stats.duration = Math.max(0, now - job.created);
      // Persist the next permitted start before making the network request.
      await this.state.storage.put("next", now + INTERVAL);
      let ok = false;
      let retryDelay = INTERVAL;
      try {
        const response = await fetch("https://api.mangadex.network/report", {
          method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
          headers: { "content-type": "application/json", "user-agent": "AniKathaAddonBridge/3.2 (+https://github.com/LMS147/anikatha-addon-bridge)" },
          body: JSON.stringify(job.stats)
        });
        ok = response.ok;
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          if (Number.isFinite(seconds) && seconds > 0) retryDelay = Math.min(300_000, Math.max(INTERVAL, seconds * 1000));
        }
      } catch { /* Keep the report and retry after backoff. */ }
      if (ok) jobs.splice(jobs.indexOf(job), 1);
      else {
        job.ready = true;
        job.attempts++;
        retryDelay = Math.max(retryDelay, Math.min(300_000, INTERVAL * 2 ** Math.min(job.attempts, 6)));
        console.error("MangaDex image report failed; queued for retry");
      }
      await this.state.storage.put({ jobs, next: now + retryDelay });
      await this.schedule(jobs);
    });
  }
}

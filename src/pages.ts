import { Failure, id, json } from "./contract";
import type { Env } from "./mangadex";

const IMAGE_LIMIT = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
type Assignment = { expiresAt: number; urls: string[] };

/** A distinct DO per assignment avoids KV's cross-region propagation delay.
 * It accepts only internally generated assignments, and deletes them on expiry. */
export class PageStore {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      const assignment = await request.json<Assignment>();
      if (!Number.isFinite(assignment.expiresAt) || !Array.isArray(assignment.urls) || assignment.urls.length > 500)
        return new Response(null, { status: 400 });
      await this.state.storage.put("assignment", assignment);
      await this.state.storage.setAlarm(assignment.expiresAt);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const assignment = await this.state.storage.get<Assignment>("assignment");
    if (!assignment || assignment.expiresAt <= Date.now()) return new Response(null, { status: 404 });
    return Response.json(assignment);
  }
  async alarm(): Promise<void> {
    const assignment = await this.state.storage.get<Assignment>("assignment");
    if (assignment && assignment.expiresAt > Date.now()) await this.state.storage.setAlarm(assignment.expiresAt);
    else await this.state.storage.deleteAll();
  }
}

export function pageStore(env: Env, chapter: string, assignment: string) {
  if (!env.PAGE_STORE) throw new Failure(503, "Page store is not configured");
  return env.PAGE_STORE.get(env.PAGE_STORE.idFromName(`${chapter}:${assignment}`));
}

function allowedUpstream(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search && !u.port &&
      u.hostname.endsWith(".mangadex.network");
  } catch { return false; }
}

async function report(url: string, success: boolean, bytes: number, duration: number, cached: boolean): Promise<void> {
  // The image response must not wait on reporting, but transient report failures
  // get one retry while waitUntil keeps the Worker alive.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fetch("https://api.mangadex.network/report", {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "user-agent": "AniKathaAddonBridge/3.0 (+https://github.com/LMS147/anikatha-addon-bridge)" },
        body: JSON.stringify({ url, success, bytes, duration, cached })
      });
      if (result.ok) return;
      if (result.status >= 400 && result.status < 500 && result.status !== 429) break;
    } catch { /* Retry transient network errors once. */ }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.error("MangaDex image report failed");
}

export async function image(env: Env, ctx: ExecutionContext, chapter: string, assignmentId: string, index: string): Promise<Response> {
  if (!id(`md:ch:${chapter}`, "md:ch:") || !id(`md:${assignmentId}`, "md:") || !/^(0|[1-9]\d{0,2})$/.test(index)) return json({ error: "Not found" }, 404);
  const stored = await pageStore(env, chapter, assignmentId).fetch("https://pages.internal/");
  if (!stored.ok) return json({ error: "Page assignment expired; refresh sources" }, 404);
  const assignment = await stored.json<Assignment>();
  const url = assignment.urls[Number(index)];
  // Only URLs obtained from MangaDex and saved server-side can be fetched.
  if (!url || !allowedUpstream(url)) return json({ error: "Not found" }, 404);
  const started = Date.now();
  let success = false, bytes = 0, cached = false;
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "AniKathaAddonBridge/3.0 (+https://github.com/LMS147/anikatha-addon-bridge)" } });
    cached = (response.headers.get("x-cache") ?? "").toUpperCase().startsWith("HIT");
    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!response.ok || !IMAGE_TYPES.has(contentType) || Number(response.headers.get("content-length") || 0) > IMAGE_LIMIT || !response.body)
      throw new Error("Invalid upstream image");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > IMAGE_LIMIT) { await reader.cancel(); throw new Error("Image exceeds limit"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    success = true;
    return new Response(data, { headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return json({ error: "Image source unavailable; refresh sources" }, 503);
  } finally {
    ctx.waitUntil(report(url, success, bytes, Date.now() - started, cached));
  }
}

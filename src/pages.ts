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
      (u.hostname === "mangadex.org" || u.hostname.endsWith(".mangadex.org") || u.hostname.endsWith(".mangadex.network"));
  } catch { return false; }
}

// Mirrors AniKatha's image signature detection; actual offline downloads also
// validate the full file/container, which cannot be proven from a prefix alone.
export function imageSignature(bytes: Uint8Array, type: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (type === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((x, i) => bytes[i] === x);
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/gif") return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  if (type === "image/webp") return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (type === "image/avif") return bytes.length >= 12 && ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12));
  return false;
}

export async function image(env: Env, ctx: ExecutionContext, chapter: string, assignmentId: string, index: string): Promise<Response> {
  if (!id(`md:ch:${chapter}`, "md:ch:") || !id(`md:${assignmentId}`, "md:") || !/^(0|[1-9]\d{0,2})$/.test(index)) return json({ error: "Not found" }, 404);
  const stored = await pageStore(env, chapter, assignmentId).fetch("https://pages.internal/");
  if (!stored.ok) return json({ error: "Page assignment expired; refresh sources" }, 404);
  const assignment = await stored.json<Assignment>();
  const url = assignment.urls[Number(index)];
  if (!url || !allowedUpstream(url)) return json({ error: "Not found" }, 404);
  if (!env.REPORT_QUEUE) return json({ error: "Image reporting unavailable" }, 503);
  const queue = env.REPORT_QUEUE.get(env.REPORT_QUEUE.idFromName("global"));
  // Reserve before retrieving any image, so a full/unavailable queue fails closed.
  const reserved = await queue.fetch("https://reports.internal/reserve", { method: "POST", body: JSON.stringify({ url }) });
  if (!reserved.ok) return json({ error: "Image reporting queue unavailable" }, 503);
  const ticket = await reserved.json<{ id: string }>();
  const started = Date.now();
  let bytes = 0, cached = false, finished = false;
  let complete!: () => void;
  const completion = new Promise<void>(resolve => { complete = resolve; });
  ctx.waitUntil(completion);
  const finish = async (success: boolean) => {
    if (finished) return;
    finished = true;
    try {
      const result = await queue.fetch("https://reports.internal/complete", { method: "POST", body: JSON.stringify({ id: ticket.id, success, cached, bytes, duration: Date.now() - started }) });
      if (!result.ok) console.error("Failed to complete queued image report");
    } catch { console.error("Failed to complete queued image report"); }
    finally { complete(); }
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "AniKathaAddonBridge/3.2 (+https://github.com/LMS147/anikatha-addon-bridge)" } });
    cached = (response.headers.get("x-cache") ?? "").toUpperCase().startsWith("HIT");
    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!response.ok || !IMAGE_TYPES.has(contentType) || Number(response.headers.get("content-length") || 0) > IMAGE_LIMIT || !response.body)
      throw new Error("Invalid upstream image");
    reader = response.body.getReader();
    const first: Uint8Array[] = [];
    let headerSize = 0;
    while (headerSize < 12) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > IMAGE_LIMIT) throw new Error("Image exceeds limit");
      headerSize += chunk.value.length;
      first.push(chunk.value);
    }
    const header = new Uint8Array(Math.min(headerSize, 12));
    let offset = 0;
    for (const chunk of first) {
      const part = chunk.subarray(0, Math.max(0, 12 - offset));
      header.set(part, offset); offset += part.length;
      if (offset === 12) break;
    }
    if (!imageSignature(header, contentType)) throw new Error("Unsupported image signature");
    const source = reader;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of first) controller.enqueue(chunk); },
      async pull(controller) {
        try {
          const next = await source.read();
          if (next.done) { controller.close(); source.releaseLock(); await finish(true); return; }
          bytes += next.value.byteLength;
          if (bytes > IMAGE_LIMIT) { await source.cancel(); throw new Error("Image exceeds limit"); }
          controller.enqueue(next.value);
        } catch (error) { controller.error(error); try { source.releaseLock(); } catch {} await finish(false); }
      },
      async cancel() { try { await source.cancel(); source.releaseLock(); } finally { await finish(false); } }
    });
    return new Response(body, { headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch {
    if (reader) { try { await reader.cancel(); reader.releaseLock(); } catch {} }
    await finish(false);
    return json({ error: "Image source unavailable; refresh sources" }, 503);
  }
}

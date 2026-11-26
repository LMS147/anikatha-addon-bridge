import { Failure, segment } from "./contract";
import { imageSignature } from "./pages";

const COVER_LIMIT = 2 * 1024 * 1024;

export async function cover(uuid: string, filename: string): Promise<Response> {
  if (!segment(filename) || !/\.(?:jpe?g|png|webp|gif|avif)$/i.test(filename))
    throw new Failure(404, "Cover not found");

  const response = await fetch(`https://uploads.mangadex.org/covers/${uuid}/${filename}.512.jpg`, {
    redirect: "manual", signal: AbortSignal.timeout(8_000), headers: { accept: "image/jpeg,image/png,image/webp,image/gif,image/avif" }
  });
  if (response.status === 404) throw new Failure(404, "Cover not found");
  const type = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || !response.body || Number(response.headers.get("content-length") || 0) > COVER_LIMIT)
    throw new Failure(502, "Cover unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > COVER_LIMIT) {
      await reader.cancel();
      throw new Failure(502, "Cover too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (!imageSignature(bytes, type)) throw new Failure(502, "Unsupported cover image");
  return new Response(bytes, {
    headers: { "content-type": type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" }
  });
}

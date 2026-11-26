import { Failure, id, segment } from "./contract";

export const PAGE_SIZE = 20;
export const RATED_LIMIT = 60;

export type Entity = {
  id: string;
  attributes: Record<string, unknown>;
  relationships?: Array<{ type?: unknown; attributes?: { fileName?: unknown } }>;
};

const statuses = { ongoing: "Publishing", completed: "Completed", hiatus: "Hiatus", cancelled: "Cancelled" } as const;
const formats = [
  { tag: "Oneshot", name: "One-shot" },
  { tag: "Doujinshi", name: "Doujinshi" },
  { tag: "Anthology", name: "Anthology" },
  { tag: "4-Koma", name: "4-Koma" },
  { tag: "Web Comic", name: "Web Comic" }
] as const;
export const catalogExtras = [
  { name: "search", isRequired: false }, { name: "skip", isRequired: false },
  { name: "genre", isRequired: false }, { name: "tag", isRequired: false }, { name: "year", isRequired: false },
  { name: "format", isRequired: false, options: formats.map(format => format.name) },
  { name: "status", isRequired: false, options: Object.values(statuses) }
];

export const manifest = {
  id: "org.anikatha.addon-bridge.mangadex", version: "3.3.0", anikathaProtocolVersion: 1,
  name: "AniKatha MangaDex Bridge", description: "MangaDex manga and manhwa discovery and reading.",
  types: ["manga"],
  resources: [
    { name: "catalog", types: ["manga"] },
    { name: "meta", types: ["manga"], idPrefixes: ["md:"] },
    { name: "chapters", types: ["manga"], idPrefixes: ["md:"] },
    { name: "pages", types: ["manga"], idPrefixes: ["md:ch:"] }
  ],
  catalogs: [
    { type: "manga", id: "mangadex", name: "MangaDex", extra: catalogExtras },
    { type: "manga", id: "manhwa", name: "Manhwa (Korean originals)", extra: catalogExtras },
    { type: "manga", id: "top-rated", name: "MangaDex Top Rated", ranking: "score", extra: catalogExtras }
  ]
};

const key = (value: string) => value.trim().toLowerCase();
function nameOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const names = value as Record<string, unknown>;
  for (const name of [names.en, ...Object.values(names)]) {
    if (typeof name === "string" && name.trim()) return name.trim();
  }
}

export function normalizedTags(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: { id: string; name: string; group: string }[] = [];
  for (const item of raw) {
    const uuid = typeof item?.id === "string" ? id(item.id, "") : null;
    const name = nameOf(item?.attributes?.name);
    const group = item?.attributes?.group;
    if (!uuid || !name || !["genre", "theme", "format", "content"].includes(group) || seen.has(uuid)) continue;
    seen.add(uuid);
    tags.push({ id: uuid, name, group });
  }
  return tags;
}

function uniqueNames(tags: { name: string }[]) {
  return [...new Map(tags.map(tag => [key(tag.name), tag.name])).values()];
}

export function title(item: Entity) {
  const uuid = typeof item?.id === "string" ? id(item.id, "") : null;
  const name = nameOf(item?.attributes?.title);
  if (!uuid || !name) throw new Failure(502, "Invalid MangaDex title");

  const file = Array.isArray(item.relationships)
    ? item.relationships.find(relation => relation?.type === "cover_art")?.attributes?.fileName
    : undefined;
  const poster = segment(file) ? `https://uploads.mangadex.org/covers/${uuid}/${file}.512.jpg` : undefined;
  const tags = normalizedTags(item.attributes.tags);
  const genreTags = tags.filter(tag => tag.group === "genre");
  const otherTags = tags.filter(tag => tag.group !== "genre");
  const format = formats.find(format => tags.some(tag => tag.group === "format" && key(tag.name) === key(format.tag)))?.name;
  const year = item.attributes.year;
  const upstreamStatus = item.attributes.status;
  const status = typeof upstreamStatus === "string" && Object.hasOwn(statuses, upstreamStatus)
    ? statuses[upstreamStatus as keyof typeof statuses] : undefined;
  return {
    id: `md:${uuid}`, type: "manga", name,
    ...(genreTags.length ? { genres: uniqueNames(genreTags) } : {}),
    ...(otherTags.length ? { tags: uniqueNames(otherTags), tagIds: otherTags.map(tag => tag.id) } : {}),
    ...(format ? { format } : {}),
    ...(typeof year === "number" && Number.isInteger(year) && year > 0 ? { year } : {}),
    ...(status ? { status } : {}),
    ...(poster ? { poster } : {})
  };
}

export type CatalogTitle = ReturnType<typeof title> & { communityScore?: number; rank?: number };

export function parseExtras(segment: string | undefined) {
  const extras = new Map<string, string>();
  if (!segment) return extras;
  for (const part of segment.split("&")) {
    const split = part.indexOf("=");
    if (split < 0) throw new Failure(400, "Invalid extras");
    const name = decodeURIComponent(part.slice(0, split));
    const value = decodeURIComponent(part.slice(split + 1)).trim();
    if (!catalogExtras.some(extra => extra.name === name) || extras.has(name) || value.length > 200)
      throw new Failure(400, "Invalid extras");
    if (name === "skip" && (!/^\d{1,4}$/.test(value) || Number(value) > 9980))
      throw new Failure(400, "Invalid offset");
    extras.set(name, value);
  }
  return extras;
}

export function applyFilters(params: URLSearchParams, extras: ReadonlyMap<string, string>, taxonomy: ReturnType<typeof normalizedTags>) {
  const year = extras.get("year");
  if (year !== undefined) {
    if (!/^\d{4}$/.test(year) || Number(year) === 0) throw new Failure(400, "Invalid release year");
    params.set("year", year);
  }
  const status = extras.get("status");
  if (status !== undefined) {
    const found = Object.entries(statuses).find(([value, label]) => value === key(status) || key(label) === key(status));
    if (!found) throw new Failure(400, "Invalid publication status");
    params.append("status[]", found[0]);
  }

  const required = new Set<string>();
  for (const field of ["genre", "tag"]) {
    const value = extras.get(field);
    if (value === undefined) continue;
    const found = taxonomy.filter(tag => (field === "genre" ? tag.group === "genre" : tag.group !== "genre") &&
      (tag.id === key(value) || key(tag.name) === key(value)));
    if (found.length !== 1) throw new Failure(400, `Invalid ${field}; use an unambiguous MangaDex name or tag UUID`);
    required.add(found[0].id);
  }

  const format = extras.get("format");
  if (format !== undefined) {
    const priority = formats.findIndex(entry => key(entry.name) === key(format));
    if (priority < 0) throw new Failure(400, "Invalid format");
    const formatTags = taxonomy.filter(tag => tag.group === "format");
    const found = formatTags.find(tag => key(tag.name) === key(formats[priority].tag));
    if (!found) throw new Failure(503, "MangaDex format is unavailable");
    required.add(found.id);
    for (const preferred of formats.slice(0, priority)) {
      const tag = formatTags.find(entry => key(entry.name) === key(preferred.tag));
      if (tag) params.append("excludedTags[]", tag.id);
    }
    if (params.has("excludedTags[]")) params.set("excludedTagsMode", "OR");
  }
  for (const tag of [...required].sort()) params.append("includedTags[]", tag);
  if (required.size) params.set("includedTagsMode", "AND");
}

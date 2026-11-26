import crossLinks from "./verified-formats.json";

export type VerifiedShelf = { format: "Manga" | "Manhwa"; ids: ReadonlyMap<string, string> };

function fromCatalog(format: VerifiedShelf["format"]): VerifiedShelf {
  return { format, ids: new Map(crossLinks[format].map(row => [row.mangaDexId, row.mangaUpdatesId])) };
}

const manga = fromCatalog("Manga");
const manhwa = fromCatalog("Manhwa");

export function verifiedShelf(catalog: string): VerifiedShelf | undefined {
  if (catalog === "popular-manga") return manga;
  if (catalog === "popular-manhwa") return manhwa;
}

using Microsoft.AspNetCore.Http.Features;
using AniKathaAddonBridge.Upstream;

namespace AniKathaAddonBridge;

public static class Router
{
    public static void MapBridge(this WebApplication app)
    {
        app.MapGet("/anikatha/manifest.json", () => Contract.Json(Contract.Manifest));
        app.MapGet("/anikatha/catalog/manga/mangadex.json", async (MangaDexClient client, CancellationToken ct) =>
            Contract.Json(await client.Search(null, 0, ct)));
        // Parse the raw segment so an escaped ampersand in a search term is not treated as a separator.
        app.MapGet("/anikatha/catalog/manga/mangadex/{**extra}", async (HttpContext context, MangaDexClient client, CancellationToken ct) =>
        {
            var rawPath = (context.Features.Get<IHttpRequestFeature>()?.RawTarget ?? "").Split('?', 2)[0];
            const string prefix = "/anikatha/catalog/manga/mangadex/";
            if (!rawPath.StartsWith(prefix, StringComparison.Ordinal) || !rawPath.EndsWith(".json", StringComparison.Ordinal)) return Results.Json(new { rawPath }, statusCode: 404);
            var segment = rawPath[prefix.Length..^5];
            string? search = null;
            var skip = 0;
            var seen = new HashSet<string>();
            foreach (var part in segment.Split('&'))
            {
                var separator = part.IndexOf('=');
                if (separator < 0) return Results.BadRequest(new { error = "Invalid catalog extras" });
                var key = Uri.UnescapeDataString(part[..separator]);
                var value = Uri.UnescapeDataString(part[(separator + 1)..]);
                if (!seen.Add(key)) return Results.BadRequest(new { error = "Duplicate catalog extra" });
                if (key == "search") search = value;
                else if (key == "skip" && int.TryParse(value, out var parsed) && parsed is >= 0 and <= 9980) skip = parsed;
                else return Results.BadRequest(new { error = "Invalid catalog extra" });
            }
            if (search?.Length > 200) return Results.BadRequest(new { error = "Search too long" });
            return Contract.Json(await client.Search(search, skip, ct));
        });
        app.MapGet("/anikatha/meta/manga/{id}.json", async (string id, MangaDexClient client, CancellationToken ct) =>
        {
            if (!Contract.TryId(Uri.UnescapeDataString(id), "md:", out var guid)) return Results.NotFound();
            var result = await client.Meta(guid, ct);
            return result is null ? Results.NotFound() : Contract.Json(result);
        });
        app.MapGet("/anikatha/chapters/manga/{id}.json", async (string id, MangaDexClient client, CancellationToken ct) =>
        {
            if (!Contract.TryId(Uri.UnescapeDataString(id), "md:", out var guid)) return Results.NotFound();
            var result = await client.Chapters(guid, ct);
            return result is null ? Results.NotFound() : Contract.Json(result);
        });
        app.MapGet("/anikatha/pages/manga/{id}.json", async (string id, MangaDexClient client, CancellationToken ct) =>
        {
            if (!Contract.TryId(Uri.UnescapeDataString(id), "md:ch:", out var guid)) return Results.NotFound();
            var result = await client.Pages(guid, ct);
            return result is null ? Results.NotFound() : Contract.Json(result);
        });
        // No verified mapping or licensed source has been supplied. Never invent one.
        app.MapGet("/anikatha/meta/anime/{id}.json", (string id) => Results.NotFound());
        app.MapGet("/anikatha/stream/anime/{id}.json", (string id) => Results.NotFound());
    }
}

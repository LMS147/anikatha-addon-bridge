using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;

namespace AniKathaAddonBridge.Upstream;

public sealed class MangaDexClient(HttpClient http, IMemoryCache cache, UpstreamGate gate)
{
    private const int UpstreamLimit = 2 * 1024 * 1024;

    private async Task<JsonElement?> Get(string path, bool cacheable, CancellationToken token)
    {
        if (cacheable && cache.TryGetValue<JsonElement>(path, out var hit)) return hit;
        await gate.WaitAsync(token);
        try
        {
            using var response = await http.GetAsync(path, HttpCompletionOption.ResponseHeadersRead, token);
            if (response.StatusCode == HttpStatusCode.NotFound) return null;
            // Redirects and throttling are failures, not missing units. Don't follow redirects.
            if (!response.IsSuccessStatusCode) throw new UpstreamException(502);
            if (response.Content.Headers.ContentLength > UpstreamLimit) throw new UpstreamException(502);
            await using var stream = await response.Content.ReadAsStreamAsync(token);
            using var memory = new MemoryStream();
            var buffer = new byte[8192];
            int read;
            while ((read = await stream.ReadAsync(buffer, token)) > 0)
            {
                if (memory.Length + read > UpstreamLimit) throw new UpstreamException(502);
                memory.Write(buffer, 0, read);
            }
            using var doc = JsonDocument.Parse(memory.ToArray());
            var result = doc.RootElement.Clone();
            if (cacheable) cache.Set(path, result, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5), Size = 1 });
            return result;
        }
        catch (OperationCanceledException ex) when (!token.IsCancellationRequested) { throw new UpstreamException(504, ex); }
        catch (HttpRequestException ex) { throw new UpstreamException(502, ex); }
        catch (JsonException ex) { throw new UpstreamException(502, ex); }
    }

    public async Task<object> Search(string? query, int skip, CancellationToken token)
    {
        var path = $"manga?limit=20&offset={skip}&contentRating%5B%5D=safe&contentRating%5B%5D=suggestive";
        if (!string.IsNullOrWhiteSpace(query)) path += "&title=" + Uri.EscapeDataString(query);
        var json = await Get(path, true, token) ?? throw new UpstreamException(502);
        try
        {
            var metas = json.GetProperty("data").EnumerateArray().Select(Title).ToArray();
            return new { metas };
        }
        catch (Exception ex) when (ex is InvalidOperationException or KeyNotFoundException or FormatException) { throw new UpstreamException(502, ex); }
    }

    private static object Title(JsonElement item)
    {
        var id = Guid.Parse(item.GetProperty("id").GetString()!);
        var attrs = item.GetProperty("attributes");
        var titles = attrs.GetProperty("title");
        var name = titles.TryGetProperty("en", out var english) ? english.GetString() : titles.EnumerateObject().FirstOrDefault().Value.GetString();
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidOperationException("Missing manga title");
        return new { id = "md:" + id, type = "manga", name };
    }

    public async Task<object?> Meta(Guid id, CancellationToken token)
    {
        var json = await Get($"manga/{id:D}", true, token);
        if (json is null) return null;
        try { return new { meta = Title(json.Value.GetProperty("data")) }; }
        catch (Exception ex) when (ex is InvalidOperationException or KeyNotFoundException or FormatException) { throw new UpstreamException(502, ex); }
    }

    public async Task<object?> Chapters(Guid id, CancellationToken token)
    {
        // Check the title separately: an unknown title must not be mistaken for an empty feed.
        if (await Get($"manga/{id:D}", true, token) is null) return null;
        var chapters = new List<object>();
        for (var offset = 0; offset < 10000; offset += 100)
        {
            var json = await Get($"manga/{id:D}/feed?limit=100&offset={offset}&order%5Bchapter%5D=asc", true, token);
            if (json is null) return null;
            try
            {
                var root = json.Value;
                var data = root.GetProperty("data").EnumerateArray().ToArray();
                foreach (var chapter in data)
                {
                    var chapterId = Guid.Parse(chapter.GetProperty("id").GetString()!);
                    var attrs = chapter.GetProperty("attributes");
                    var number = attrs.TryGetProperty("chapter", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
                    var title = attrs.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
                    var lang = attrs.TryGetProperty("translatedLanguage", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString() : null;
                    chapters.Add(new { id = "md:ch:" + chapterId, title = (number is null ? "Chapter" : "Chapter " + number) + (string.IsNullOrWhiteSpace(title) ? "" : " — " + title) + (string.IsNullOrWhiteSpace(lang) ? "" : " [" + lang + "]") });
                }
                if (JsonSerializer.SerializeToUtf8Bytes(new { chapters }).Length > Contract.MaxBytes) throw new UpstreamException(502);
                var total = root.GetProperty("total").GetInt32();
                if (offset + data.Length >= total) return new { chapters };
                if (data.Length == 0) throw new UpstreamException(502);
            }
            catch (Exception ex) when (ex is InvalidOperationException or KeyNotFoundException or FormatException) { throw new UpstreamException(502, ex); }
        }
        throw new UpstreamException(502); // Do not silently return a truncated feed.
    }

    public async Task<object?> Pages(Guid id, CancellationToken token)
    {
        // At-home assignments are short lived: never cache them or hardcode the host.
        var json = await Get($"at-home/server/{id:D}", false, token);
        if (json is null) return null;
        try
        {
            var root = json.Value;
            var baseUrl = root.GetProperty("baseUrl").GetString()!;
            if (!Contract.PublicHttps(baseUrl)) throw new UpstreamException(502);
            var baseUri = new Uri(baseUrl);
            if (!string.IsNullOrEmpty(baseUri.Query)) throw new UpstreamException(502);
            var chapter = root.GetProperty("chapter");
            var hash = chapter.GetProperty("hash").GetString()!;
            if (!Contract.SafeSegment(hash)) throw new UpstreamException(502);
            var pages = chapter.GetProperty("data").EnumerateArray().Select(page =>
            {
                var filename = page.GetString()!;
                if (!Contract.SafeSegment(filename)) throw new UpstreamException(502);
                return baseUrl.TrimEnd('/') + "/data/" + hash + "/" + filename;
            }).ToArray();
            if (pages.Length == 0) return null;
            return new { pages, expiresAt = DateTimeOffset.UtcNow.AddMinutes(2) };
        }
        catch (Exception ex) when (ex is InvalidOperationException or KeyNotFoundException or FormatException or UriFormatException) { throw new UpstreamException(502, ex); }
    }
}

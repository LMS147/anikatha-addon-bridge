using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace AniKathaAddonBridge;

public static class Contract
{
    public const int MaxBytes = 256 * 1024;
    public static readonly object Manifest = new
    {
        id = "org.anikatha.addon-bridge.mangadex", version = "2.0.0", anikathaProtocolVersion = 1,
        name = "AniKatha MangaDex Bridge",
        description = "MangaDex manga search and reading. Anime sources are not yet configured.",
        types = new[] { "anime", "manga" },
        resources = new object[] {
            new { name = "catalog", types = new[] { "manga" } },
            new { name = "meta", types = new[] { "manga" }, idPrefixes = new[] { "md:" } },
            new { name = "meta", types = new[] { "anime" }, idPrefixes = new[] { "anilist:" } },
            new { name = "stream", types = new[] { "anime" }, idPrefixes = new[] { "ep:" } },
            new { name = "chapters", types = new[] { "manga" }, idPrefixes = new[] { "md:" } },
            new { name = "pages", types = new[] { "manga" }, idPrefixes = new[] { "md:ch:" } }
        },
        catalogs = new[] { new { type = "manga", id = "mangadex", name = "MangaDex", extra = new[] { new { name = "search", isRequired = false }, new { name = "skip", isRequired = false } } } }
    };

    public static IResult Json(object value)
    {
        // Bound the actual UTF-8 payload, not the number of characters.
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        return bytes.Length <= MaxBytes ? Results.Json(value) : Results.Problem("Response exceeds 256 KiB.", statusCode: 502);
    }

    public static bool TryId(string? input, string prefix, out Guid id)
    {
        id = default;
        return input != null && input.StartsWith(prefix, StringComparison.Ordinal) &&
            Guid.TryParseExact(input[prefix.Length..], "D", out id);
    }

    public static bool PublicHttps(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment) ||
            string.IsNullOrEmpty(uri.Host) || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
            uri.Host.EndsWith(".local", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)) return false;
        // Reject all IP literals, including public IPs, rather than attempting to classify every private range.
        return !IPAddress.TryParse(uri.Host, out _);
    }

    public static bool SafeSegment(string s) => s.Length is > 0 and <= 255 && s is not "." and not ".." &&
        Regex.IsMatch(s, "^[A-Za-z0-9._-]+$", RegexOptions.CultureInvariant);
}

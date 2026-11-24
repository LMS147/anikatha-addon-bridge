using System.Net;
using System.Text;
using System.Text.Json;
using AniKathaAddonBridge;
using AniKathaAddonBridge.Upstream;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

public class BridgeTests : IClassFixture<BridgeTests.Factory>
{
    const string Manga = "11111111-1111-4111-8111-111111111111";
    const string Chapter = "22222222-2222-4222-8222-222222222222";
    readonly HttpClient client;
    readonly Factory factory;
    public BridgeTests(Factory factory) { this.factory = factory; client = factory.CreateClient(); }

    public sealed class Factory : WebApplicationFactory<Program>
    {
        public FakeHandler Handler { get; } = new();
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            builder.ConfigureTestServices(services =>
                services.AddHttpClient<MangaDexClient>().ConfigurePrimaryHttpMessageHandler(() => Handler));
        }
    }

    public sealed class FakeHandler : HttpMessageHandler
    {
        public string? LastQuery { get; set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            LastQuery = request.RequestUri.Query;
            var fixture = path switch {
                "/manga" => "search.json",
                "/manga/" + Manga => "manga.json",
                "/manga/" + Manga + "/feed" => "feed.json",
                "/at-home/server/" + Chapter => "at-home.json",
                _ => null
            };
            if (fixture is null) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            var text = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", fixture));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8, "application/json") });
        }
    }

    static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.True(bytes.Length <= Contract.MaxBytes);
        using var doc = JsonDocument.Parse(bytes);
        return doc.RootElement.Clone();
    }

    [Fact]
    public async Task Manifest_catalog_meta_chapters_and_ordered_pages()
    {
        var manifest = await Json(await client.GetAsync("/anikatha/manifest.json"));
        Assert.Equal(1, manifest.GetProperty("anikathaProtocolVersion").GetInt32());
        Assert.Equal(new[] { "anime", "manga" }, manifest.GetProperty("types").EnumerateArray().Select(e => e.GetString()).ToArray());
        var catalog = await Json(await client.GetAsync("/anikatha/catalog/manga/mangadex/search=one%26two&skip=20.json"));
        Assert.Contains("title=one%26two", factory.Handler.LastQuery, StringComparison.OrdinalIgnoreCase);
        var id = catalog.GetProperty("metas")[0].GetProperty("id").GetString();
        Assert.Equal("md:" + Manga, id);
        var meta = await Json(await client.GetAsync("/anikatha/meta/manga/md%3A" + Manga + ".json"));
        Assert.Equal(id, meta.GetProperty("meta").GetProperty("id").GetString());
        var chapters = await Json(await client.GetAsync("/anikatha/chapters/manga/md%3A" + Manga + ".json"));
        Assert.Equal("md:ch:" + Chapter, chapters.GetProperty("chapters")[0].GetProperty("id").GetString());
        var pages = await Json(await client.GetAsync("/anikatha/pages/manga/md%3Ach%3A" + Chapter + ".json"));
        Assert.Equal("https://uploads.mangadex.org/data/abc123/1-a.png", pages.GetProperty("pages")[0].GetString());
        Assert.Equal("https://uploads.mangadex.org/data/abc123/2-b.png", pages.GetProperty("pages")[1].GetString());
        Assert.InRange(pages.GetProperty("expiresAt").GetDateTimeOffset(), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(3));
    }

    [Fact]
    public async Task Unknown_units_and_unconfigured_anime_are_not_found()
    {
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/anikatha/stream/anime/ep%3Aunknown.json")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/anikatha/meta/anime/anilist%3A1.json")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/anikatha/pages/manga/md%3Ach%3A33333333-3333-4333-8333-333333333333.json")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/anikatha/meta/manga/tt1254207.json")).StatusCode);
    }

    [Theory]
    [InlineData("https://127.0.0.1/a")]
    [InlineData("https://site.local/a")]
    [InlineData("http://example.org/a")]
    [InlineData("https://user@example.org/a")]
    [InlineData("https://example.org/a#x")]
    public void Reject_unsafe_media_urls(string url) => Assert.False(Contract.PublicHttps(url));
}

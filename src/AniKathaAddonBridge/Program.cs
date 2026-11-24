using AniKathaAddonBridge;
using AniKathaAddonBridge.Upstream;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<UpstreamGate>();
builder.Services.AddHttpClient<MangaDexClient>(client =>
{
    client.BaseAddress = new Uri("https://api.mangadex.org/");
    client.Timeout = TimeSpan.FromSeconds(15);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("AniKathaAddonBridge/1.0 (+https://github.com/LMS147/anikatha-addon-bridge)");
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
var app = builder.Build();
app.Use(async (context, next) =>
{
    try { await next(); }
    catch (UpstreamException ex) when (!context.Response.HasStarted)
    {
        context.Response.StatusCode = ex.StatusCode;
        await context.Response.WriteAsJsonAsync(new { error = "Upstream unavailable; retry later." });
    }
});
app.MapBridge();
app.Run();

public partial class Program { }

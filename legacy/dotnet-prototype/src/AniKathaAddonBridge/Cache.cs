namespace AniKathaAddonBridge;

// One process-wide gate covers every MangaDex request, not merely each HttpClient.
public sealed class UpstreamGate
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private DateTimeOffset next = DateTimeOffset.MinValue;
    public async Task WaitAsync(CancellationToken token)
    {
        await gate.WaitAsync(token);
        try
        {
            var delay = next - DateTimeOffset.UtcNow;
            if (delay > TimeSpan.Zero) await Task.Delay(delay, token);
            next = DateTimeOffset.UtcNow.AddMilliseconds(250); // <= 4 requests/s per process
        }
        finally { gate.Release(); }
    }
}

public sealed class UpstreamException(int statusCode, Exception? inner = null) : Exception("MangaDex request failed", inner)
{
    public int StatusCode { get; } = statusCode;
}

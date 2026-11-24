/** One named Durable Object serializes all reservations across Worker isolates.
 * At-home is additionally limited to 40 scheduled requests per rolling minute.
 * Reservations beyond the caller's deadline fail closed instead of queuing indefinitely.
 */
export class RateGate {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const { home, deadline } = await request.json<{ home: boolean; deadline: number }>();
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const next = (await this.state.storage.get<number>("next")) ?? now;
      let scheduled = Math.max(now, next);
      let homes = ((await this.state.storage.get<number[]>("homes")) ?? []).filter(t => t > now - 60_000);
      if (home && homes.length >= 40) scheduled = Math.max(scheduled, homes[homes.length - 40] + 60_001);
      if (!Number.isFinite(deadline) || scheduled >= deadline - 1000) return new Response(null, { status: 503 });
      if (home) homes.push(scheduled);
      await this.state.storage.put({ next: scheduled + 250, homes });
      return Response.json({ delay: Math.max(0, scheduled - now) });
    });
  }
}

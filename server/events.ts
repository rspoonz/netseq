// Live updates over server-sent events: every open tab receives each batch's changes. Events
// aren't stored, so a tab that was disconnected reloads what it shows instead of catching up.

const encoder = new TextEncoder();
const PING_MS = 30_000; // keeps idle connections (and anything in between) from timing out

type Client = ReadableStreamDefaultController<Uint8Array>;

export class EventHub {
  private clients = new Set<Client>();
  private pinger: ReturnType<typeof setInterval> | undefined;

  get size(): number {
    return this.clients.size;
  }

  /** The streaming response for GET /api/events. */
  connect(): Response {
    let client: Client;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = controller;
        this.clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
        this.pinger ??= setInterval(() => this.send(": ping\n\n"), PING_MS);
      },
      cancel: () => {
        this.clients.delete(client);
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }

  publish(event: string, data: unknown): void {
    this.send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); // JSON has no raw newlines
  }

  close(): void {
    clearInterval(this.pinger);
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
    this.clients.clear();
  }

  private send(text: string): void {
    const bytes = encoder.encode(text);
    for (const client of this.clients) {
      try {
        client.enqueue(bytes);
      } catch {
        this.clients.delete(client); // the browser went away
      }
    }
  }
}

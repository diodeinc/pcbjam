/** Metadata only: never accept model contents, RPC payloads, paths or error text. */
export class KicadDiagnostics {
  private sequence = 0;
  private events: Array<{
    sequence: number;
    timeMs: number;
    event: string;
    detail: Record<string, number | boolean>;
  }> = [];

  record(event: string, detail: Record<string, number | boolean> = {}) {
    this.events.push({
      sequence: ++this.sequence,
      timeMs: Date.now(),
      event,
      detail: { ...detail },
    });
    if (this.events.length > 400) this.events.shift();
  }

  snapshot() {
    return this.events.map((event) => ({
      ...event,
      detail: { ...event.detail },
    }));
  }
}

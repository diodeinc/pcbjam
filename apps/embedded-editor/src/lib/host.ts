// SPDX-License-Identifier: GPL-3.0-only
export const APP_PROTOCOL = "diode-pcbjam-app-v1";
export type Identity = { session: string; nonce: string; parentOrigin: string };
export type Method = "connect" | "sync" | "read-project" | "draft-load" | "draft-merge" | "disconnect";
export type Status = { pendingWrites: boolean; storageFailed: boolean; phase?: string };
export type SyncParams = { update?: string; stateVector?: string; includeContents?: boolean };
export type SyncResult = { update?: string; contents?: string; busy?: boolean; rejected?: string; connectedSessions?: number };
export type Open = { filename: string; readOnly: boolean; theme: "light" | "dark" };

export function parseIdentity(search: string, embedded: boolean): Identity | null {
  const q = new URLSearchParams(search);
  if (!embedded && !q.has("session") && !q.has("nonce") && !q.has("parentOrigin")) return null;
  const session = q.get("session"), nonce = q.get("nonce"), parentOrigin = q.get("parentOrigin");
  if (!embedded || !session || !nonce || !parentOrigin) throw new Error("Incomplete editor host identity");
  const origin = new URL(parentOrigin);
  if (!/^https?:$/.test(origin.protocol) || origin.origin !== parentOrigin) throw new Error("Expected exact HTTP(S) parent origin");
  return { session, nonce, parentOrigin };
}
export function validMessage(event: MessageEvent, parent: unknown, identity: Identity): boolean {
  const m = event.data;
  return event.source === parent && event.origin === identity.parentOrigin && !!m &&
    m.protocol === APP_PROTOCOL && m.session === identity.session && m.nonce === identity.nonce &&
    typeof m.type === "string";
}
export function validateOpen(value: unknown): Open {
  const p = value as Open;
  if (!p || typeof p.filename !== "string" || !/^[^\\/]+\.kicad_pcb$/i.test(p.filename) ||
      typeof p.readOnly !== "boolean" || !["light", "dark"].includes(p.theme)) throw new Error("Invalid open request");
  return { filename: p.filename, readOnly: p.readOnly, theme: p.theme };
}
export class HostConnection {
  onChange = () => {};
  onDisconnect = (_reason: Error) => {};
  onOpen = (_open: Open) => {};
  onPolicy = (_readOnly: boolean) => {};
  onTheme = (_theme: "light" | "dark") => {};
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private identity: Identity, private target: Window = window.parent, private events: Window = window) {
    events.addEventListener("message", this.receive);
  }
  send(type: string, payload?: unknown, requestId?: string) {
    const { session, nonce, parentOrigin } = this.identity;
    this.target.postMessage({ protocol: APP_PROTOCOL, session, nonce, type, requestId, payload }, parentOrigin);
  }
  receive = (event: MessageEvent) => {
    if (!validMessage(event, this.target, this.identity)) return;
    const { type, requestId, payload } = event.data;
    if (type === "response" && typeof requestId === "string" && payload && typeof payload === "object") {
      const p = this.pending.get(requestId);
      if (!p) return;
      if (!("result" in payload) && typeof payload.error !== "string") return;
      clearTimeout(p.timer); this.pending.delete(requestId);
      if (typeof payload.error === "string") p.reject(new Error(payload.error)); else p.resolve(payload.result);
    } else if (type === "open") {
      try { this.onOpen(validateOpen(payload)); } catch (error) { this.onDisconnect(error as Error); }
    } else if (type === "invalidate") this.onChange();
    else if (type === "disconnected" && typeof payload?.message === "string") this.onDisconnect(new Error(payload.message));
    else if (type === "set-policy" && typeof payload?.readOnly === "boolean") this.onPolicy(payload.readOnly);
    else if (type === "set-theme" && ["light", "dark"].includes(payload?.theme)) this.onTheme(payload.theme);
  };
  request<T = unknown>(method: Method, params?: unknown): Promise<T> {
    if (this.pending.size >= 64) return Promise.reject(new Error("Host request queue full"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Host ${method} timed out; unsaved drafts remain protected`)); }, 300_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send("request", { method, ...(params === undefined ? {} : { params }) }, id);
    });
  }
  connect() { return this.request("connect"); }
  sync(params: SyncParams) { return this.request<SyncResult>("sync", params); }
  status(status: Status) { this.send("status", status); }
  close() { void this.request("disconnect").catch(() => {}); }
  dispose() {
    this.close();
    this.events.removeEventListener("message", this.receive);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Editor disposed")); }
    this.pending.clear();
  }
}

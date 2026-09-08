import { describe, expect, it, vi } from "vitest";
import { APP_PROTOCOL, HostConnection, parseIdentity, validMessage, validateOpen } from "./host";
const identity = {session:"s", nonce:"n", parentOrigin:"https://host.test"};
describe("outer application boundary", () => {
  it("accepts only an exact HTTP(S) parent origin and complete embedded identity", () => {
    expect(parseIdentity("", false)).toBeNull();
    expect(parseIdentity("?session=s&nonce=n&parentOrigin=https://host.test", true)).toEqual(identity);
    for (const origin of ["*", "null", "https://host.test/", "https://host.test/path", "data:text/html,a"]) {
      expect(() => parseIdentity(`?session=s&nonce=n&parentOrigin=${encodeURIComponent(origin)}`, true)).toThrow();
    }
    expect(() => parseIdentity("", true)).toThrow();
  });
  it("rejects wrong source, origin, session, nonce and native envelopes", () => {
    const parent = {};
    const event = {source:parent, origin:identity.parentOrigin, data:{...identity, protocol:APP_PROTOCOL, type:"invalidate"}} as unknown as MessageEvent;
    expect(validMessage(event, parent, identity)).toBe(true);
    expect(validMessage({...event, source:{}} as MessageEvent, parent, identity)).toBe(false);
    expect(validMessage({...event, origin:"https://evil.test"}, parent, identity)).toBe(false);
    for (const patch of [{session:"bad"}, {nonce:"bad"}, {protocol:"diode-kicad-wasm-v1"}]) {
      expect(validMessage({...event, data:{...event.data, ...patch}}, parent, identity)).toBe(false);
    }
    expect(() => validateOpen({filename:"/private/a.kicad_pcb",readOnly:false,theme:"light"})).toThrow();
  });
  it("correlates capabilities and relays notifications, never native commands", async () => {
    const target = {postMessage:vi.fn()} as unknown as Window;
    const events = new EventTarget() as unknown as Window;
    const host = new HostConnection(identity, target, events);
    host.onChange = vi.fn(); host.onPolicy = vi.fn(); host.onTheme = vi.fn();
    const respond = (type:string, payload:unknown, requestId?:string) => host.receive({source:target,origin:identity.parentOrigin,data:{protocol:APP_PROTOCOL,...identity,type,payload,requestId}} as unknown as MessageEvent);
    const draft = host.request("draft-merge", {doc:"doc",confirmed:"confirmed"});
    const [message, origin] = vi.mocked(target.postMessage).mock.calls[0];
    expect(origin).toBe(identity.parentOrigin);
    expect(message.payload).toEqual({method:"draft-merge",params:{doc:"doc",confirmed:"confirmed"}});
    respond("response", {result:"committed"}, message.requestId);
    await expect(draft).resolves.toBe("committed");
    const failed = host.connect();
    const last = vi.mocked(target.postMessage).mock.calls.at(-1)![0];
    respond("response", {error:"offline"}, last.requestId);
    await expect(failed).rejects.toThrow("offline");
    respond("invalidate", undefined); respond("set-policy",{readOnly:true}); respond("set-theme",{theme:"dark"});
    expect(host.onChange).toHaveBeenCalledOnce(); expect(host.onPolicy).toHaveBeenCalledWith(true); expect(host.onTheme).toHaveBeenCalledWith("dark");
    host.dispose();
    expect(vi.mocked(target.postMessage).mock.calls.at(-1)![0].payload.method).toBe("disconnect");
  });
});

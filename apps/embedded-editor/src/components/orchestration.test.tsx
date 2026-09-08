import { afterEach, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { SandboxKicadPane } from "./SandboxKicadPane";
import { seedKicadDoc, updateBase64, materializeRootDiff } from "../lib/collab";
import type { HostConnection } from "../lib/host";

const native = vi.hoisted(() => ({ props: null as any, snapshot: "", lock: null as Promise<boolean> | null, handles: null as any }));
vi.mock("./KicadWasmFrame", () => ({
  KicadWasmFrame: forwardRef((props: any, ref) => {
    native.props = props;
    useImperativeHandle(ref, () => native.handles);
    useEffect(() => { props.onReady(); }, []);
    return null;
  }),
}));
let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
const base = `(kicad_pcb (version 20241229) (gr_line (start 0 0) (end 5 0) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "line-1")))`;
const snapshot = (contents: string) => {
  const doc = seedKicadDoc(contents);
  try { return JSON.stringify(materializeRootDiff({root:"kicad_pcb",layout:[],items:{}}, doc)); }
  finally { doc.destroy(); }
};
async function setup() {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), {hidden:false}));
  native.snapshot = snapshot(base); native.lock = null;
  native.handles = {
    tryLock:vi.fn(() => native.lock ?? Promise.resolve(true)), unlock:vi.fn(async () => {}),
    snapshotItems:vi.fn(async () => native.snapshot), setHistoryState:vi.fn(async () => {}),
    setReadOnly:vi.fn(async () => {}),
  };
  const server = seedKicadDoc(base); const update = updateBase64(server); server.destroy();
  const host = {
    request:vi.fn(async (method:string): Promise<unknown> => method === "draft-load" ? null : undefined),
    sync:vi.fn(async () => ({update, contents:base})),
    connect:vi.fn(async () => {}), close:vi.fn(), status:vi.fn(), onChange:() => {}, onDisconnect:() => {},
  };
  await act(async () => { renderer = create(<SandboxKicadPane boardPath="board.kicad_pcb" host={host as unknown as HostConnection} readOnly={false} />); });
  await vi.waitFor(() => expect(native.handles.setHistoryState).toHaveBeenCalled());
  return host;
}
it("does not send captured local edits until the host's durable draft merge commits", async () => {
  const host = await setup();
  let commit!: () => void;
  const durable = new Promise<void>(resolve => { commit = resolve; });
  host.request.mockImplementation(async method => method === "draft-merge" ? durable : undefined);
  native.snapshot = snapshot(base.replace("end 5 0", "end 8 0"));
  await act(async () => { native.props.onChanged(); });
  await vi.waitFor(() => expect(host.request).toHaveBeenCalledWith("draft-merge", expect.objectContaining({doc:expect.any(String),confirmed:expect.any(String)})));
  expect(host.status).toHaveBeenCalledWith({pendingWrites:true,storageFailed:false});
  const count = host.sync.mock.calls.length;
  await act(async () => { host.onChange(); });
  expect(host.sync).toHaveBeenCalledTimes(count);
  await act(async () => { commit(); });
  await vi.waitFor(() => expect(host.sync.mock.calls.length).toBeGreaterThan(count));
  expect(host.status).toHaveBeenCalledWith({pendingWrites:false,storageFailed:false});
});
it("keeps network sync independent of a suspended native renderer", async () => {
  const host = await setup();
  let unlock!: (value:boolean) => void;
  native.lock = new Promise(resolve => { unlock = resolve; });
  await act(async () => { native.props.onChanged(); });
  const count = host.sync.mock.calls.length;
  await act(async () => { host.onChange(); });
  await vi.waitFor(() => expect(host.sync.mock.calls.length).toBeGreaterThan(count));
  native.lock = null;
  await act(async () => { unlock(false); });
});
it("fails closed and keeps the unload guard when durable storage rejects", async () => {
  const host = await setup();
  host.request.mockImplementation(async method => { if (method === "draft-merge") throw new Error("disk full"); return undefined; });
  native.snapshot = snapshot(base.replace("end 5 0", "end 9 0"));
  await act(async () => { native.props.onChanged(); });
  await vi.waitFor(() => expect(host.status).toHaveBeenCalledWith({pendingWrites:false,storageFailed:true}));
  expect(native.handles.setReadOnly).toHaveBeenCalledWith(true);
  expect(renderer!.root.findByProps({role:"alert"}).children.join("")).toContain("Unable to preserve local KiCad edits");
  const count = host.sync.mock.calls.length;
  await act(async () => { host.onChange(); });
  expect(host.sync).toHaveBeenCalledTimes(count);
});

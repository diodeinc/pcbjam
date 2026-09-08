// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  Y,
  applyBase64Update,
  diffItemSnapshots,
  itemWiresUpdate,
  materializeRootDiff,
  seedKicadDoc,
  stateVectorBase64,
  updateBase64,
} from "../lib/collab";
import type { HostConnection, SyncParams as KicadRpcRequest } from "../lib/host";
import type { KicadDraft } from "@/lib/kicadDrafts";
import type {
  KicadWasmFrameHandle,
  KicadWasmFrameProps,
} from "./KicadWasmFrame";
import { SandboxKicadPane } from "./SandboxKicadPane";

const mock = vi.hoisted(() => ({
  props: null as KicadWasmFrameProps | null,
  frame: {
    tryLock: vi.fn(),
    unlock: vi.fn(),
    snapshotItems: vi.fn(),
    prepareItems: vi.fn(),
    snapshotState: vi.fn(),
    applyItems: vi.fn(),
    setHistoryState: vi.fn(),
    setReadOnly: vi.fn(),
    diagnostics: vi.fn(),
  },
  sync: vi.fn(),
  close: vi.fn(),
  readDraft: vi.fn(),
  saveDraft: vi.fn(),
  changed: () => {},
}));

vi.mock("./KicadWasmFrame", async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import("react");
  return {
    KicadWasmFrame: forwardRef<KicadWasmFrameHandle, KicadWasmFrameProps>((props, ref) => {
      mock.props = props;
      useImperativeHandle(ref, () => ({ ...mock.frame, saveBoard: async () => "" }));
      useEffect(() => props.onReady?.(), []);
      return null;
    }),
  };
});

// Simulate the host's durable multi-tab merge, not app-owned storage. The
// production draft wrappers remain real, so requests cross the app boundary.
function mergeHostDraft(previous: KicadDraft | null, next: KicadDraft) {
  const doc = new Y.Doc();
  const confirmed = new Y.Doc();
  try {
    for (const draft of [previous, next]) {
      if (!draft) continue;
      applyBase64Update(doc, draft.doc);
      applyBase64Update(confirmed, draft.confirmed);
    }
    return Y.equalSnapshots(Y.snapshot(doc), Y.snapshot(confirmed))
      ? null
      : { doc: updateBase64(doc), confirmed: updateBase64(confirmed) };
  } finally {
    doc.destroy();
    confirmed.destroy();
  }
}

const board = (x: number) => `(kicad_pcb (version 20241229)
  (footprint "Lib:FP" (layer "F.Cu") (at ${x} 10) (uuid "fp-1")))`;
const snapshot = (doc: Y.Doc) =>
  JSON.stringify(
    materializeRootDiff({ root: "kicad_pcb", layout: [], items: {} }, doc)
  );
function move(doc: Y.Doc, x: number) {
  const next = seedKicadDoc(board(x));
  applyBase64Update(
    doc,
    itemWiresUpdate(doc, diffItemSnapshots(snapshot(doc), snapshot(next)))
  );
  next.destroy();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(options: { server?: Y.Doc; draft?: KicadDraft; readOnly?: boolean } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const server = options.server ?? seedKicadDoc(board(10));
  let saved = options.draft ?? null;
  mock.readDraft.mockImplementation(async () => saved);
  mock.saveDraft.mockImplementation(async (_key: string, draft: KicadDraft) => {
    saved = mergeHostDraft(saved, draft);
  });
  const native = new Y.Doc();
  applyBase64Update(native, updateBase64(server));
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  mock.frame.tryLock.mockResolvedValue(true);
  mock.frame.unlock.mockResolvedValue(undefined);
  mock.frame.snapshotItems.mockImplementation(async () => snapshot(native));
  mock.frame.prepareItems.mockResolvedValue(undefined);
  mock.frame.snapshotState.mockImplementation(async () => ({
    committed: snapshot(native),
    working: snapshot(native),
  }));
  mock.frame.applyItems.mockImplementation(async (delta: string) => {
    applyBase64Update(native, itemWiresUpdate(native, JSON.parse(delta)));
  });
  mock.frame.setHistoryState.mockResolvedValue(undefined);
  mock.frame.setReadOnly.mockResolvedValue(undefined);
  mock.sync.mockImplementation(async (request: KicadRpcRequest) => {
    if (request.update) applyBase64Update(server, request.update);
    return {
      ok: true,
      update: updateBase64(server, request.stateVector),
      contents: request.includeContents ? board(10) : undefined,
      connectedSessions: 2,
    };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const host = {
    set onChange(callback: () => void) { mock.changed = callback; },
    connect: async () => {},
    sync: mock.sync,
    close: mock.close,
    status: vi.fn(),
    request: vi.fn(async (method: string, draft?: KicadDraft) => {
      if (method === "draft-load") return mock.readDraft();
      if (method === "draft-merge") return mock.saveDraft("host-owned-key", draft);
      if (method === "read-project") return null;
      throw new Error(`Unexpected host request: ${method}`);
    }),
  } as unknown as HostConnection;
  cleanup = async () => {
    await act(async () => root.unmount());
    server.destroy();
    native.destroy();
  };
  await act(async () => {
    root.render(
      <SandboxKicadPane
        boardPath="/layout.kicad_pcb"
        host={host}
        readOnly={options.readOnly ?? false}
      />
    );
  });
  const visibility = (value: boolean) => {
    hidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const tick = async () => {
    await act(async () => vi.advanceTimersByTimeAsync(1000));
  };
  return { server, native, visibility, tick, container, host, saved: () => saved };
}

it("syncs captured edits and remote updates while a hidden renderer RPC is suspended", async () => {
  const { server, native, visibility, tick, container } = await setup();
  const unlock = deferred();
  mock.frame.unlock.mockImplementationOnce(() => unlock.promise);
  await act(async () => {
    move(native, 20);
    mock.props!.onChanged!();
  });
  visibility(true);
  await tick();
  expect(snapshot(server)).toBe(snapshot(native));

  const calls = mock.sync.mock.calls.length;
  await act(async () => {
    move(server, 30);
    mock.changed();
  });
  await tick();
  expect(mock.sync.mock.calls.length).toBeGreaterThan(calls);
  expect(mock.sync.mock.lastCall![0].stateVector).toBe(
    stateVectorBase64(server)
  );
  expect(snapshot(native)).not.toBe(snapshot(server));

  await act(async () => {
    visibility(false);
    unlock.resolve();
  });
  await tick();
  expect(snapshot(native)).toBe(snapshot(server));
  expect(
    container
      .querySelector("[data-kicad-state]")
      ?.getAttribute("data-kicad-state")
  ).toBe("collaborating");
});

it("does not acknowledge a newer update as rendered while applying an older target", async () => {
  const { server, native, tick } = await setup();
  const state = deferred();
  mock.frame.snapshotState.mockImplementationOnce(async () => {
    await state.promise;
    return { committed: snapshot(native), working: snapshot(native) };
  });
  await act(async () => {
    move(server, 20);
    mock.changed();
  });
  expect(mock.frame.snapshotState).toHaveBeenCalledTimes(1);
  await act(async () => {
    move(server, 30);
    mock.changed();
  });
  await act(async () => state.resolve());
  await tick();
  expect(mock.frame.applyItems).toHaveBeenCalledTimes(2);
  expect(snapshot(native)).toBe(snapshot(server));
});

it("stops transport and does not publish a late snapshot after unmount", async () => {
  const { native, tick } = await setup();
  const capture = deferred();
  mock.frame.snapshotItems.mockImplementationOnce(async () => {
    await capture.promise;
    return snapshot(native);
  });
  await act(async () => mock.props!.onChanged!());
  await cleanup!();
  cleanup = undefined;
  const calls = mock.sync.mock.calls.length;
  await act(async () => capture.resolve());
  await tick();
  expect(mock.close).toHaveBeenCalledOnce();
  expect(mock.sync).toHaveBeenCalledTimes(calls);
});

it("persists edits before sending them and retains a draft after a failed exchange", async () => {
  const { server, native, saved, tick } = await setup();
  const online = mock.sync.getMockImplementation()!;
  mock.sync.mockImplementation(async (request: KicadRpcRequest) => {
    const packet = new Y.Doc();
    applyBase64Update(packet, updateBase64(server));
    if (request.update) applyBase64Update(packet, request.update);
    const changed = !Y.equalSnapshots(Y.snapshot(packet), Y.snapshot(server));
    packet.destroy();
    if (changed) throw new Error("offline");
    return online(request);
  });
  const write = deferred();
  const save = mock.saveDraft.getMockImplementation()!;
  mock.saveDraft.mockImplementationOnce(
    async (key: string, draft: KicadDraft) => {
      await write.promise;
      await save(key, draft);
    }
  );
  const calls = mock.sync.mock.calls.length;
  await act(async () => {
    move(native, 20);
    mock.props!.onChanged!();
  });
  expect(mock.sync.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  expect(snapshot(server)).not.toBe(snapshot(native));
  await act(async () => write.resolve());
  await tick();
  expect(saved()).not.toBeNull();
  const recovered = new Y.Doc();
  applyBase64Update(recovered, saved()!.doc);
  expect(snapshot(recovered)).toBe(snapshot(native));
  recovered.destroy();
});

it("restores an unacknowledged edit after remount and removes it only after acknowledgment", async () => {
  const server = seedKicadDoc(board(10));
  const local = new Y.Doc();
  applyBase64Update(local, updateBase64(server));
  move(local, 20);
  const draft = { doc: updateBase64(local), confirmed: updateBase64(server) };
  const { native, tick, saved } = await setup({ server, draft });
  await tick();
  expect(snapshot(server)).toBe(snapshot(local));
  expect(snapshot(native)).toBe(snapshot(local));
  expect(saved()).toBeNull();
  local.destroy();
});

it("reports storage failure, stops writes, and warns before abandoning the in-memory edit", async () => {
  const { server, native, container, tick } = await setup();
  const before = snapshot(server);
  mock.saveDraft.mockRejectedValue(new Error("storage quota exceeded"));
  await act(async () => {
    move(native, 20);
    mock.props!.onChanged!();
  });
  await tick();
  expect(snapshot(server)).toBe(before);
  expect(container.querySelector("[role=alert]")?.textContent).toContain(
    "storage quota exceeded"
  );
  expect(mock.frame.setReadOnly).toHaveBeenLastCalledWith(true);
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

it("requires the native lock before capturing, preparing, or applying updates", async () => {
  const { server, native, tick } = await setup();
  mock.frame.snapshotItems.mockClear();
  mock.frame.tryLock.mockResolvedValue(false);
  await act(async () => { move(server, 20); mock.changed(); });
  await tick();
  expect(mock.frame.snapshotItems).not.toHaveBeenCalled();
  expect(mock.frame.prepareItems).not.toHaveBeenCalled();
  expect(mock.frame.snapshotState).not.toHaveBeenCalled();
  expect(mock.frame.applyItems).not.toHaveBeenCalled();
  expect(snapshot(native)).not.toBe(snapshot(server));
  let locked = false;
  mock.frame.tryLock.mockImplementation(async () => { locked = true; return true; });
  mock.frame.unlock.mockImplementation(async () => { expect(locked).toBe(true); locked = false; });
  for (const method of ["snapshotItems", "prepareItems", "snapshotState", "applyItems"] as const) {
    const implementation = mock.frame[method].getMockImplementation()!;
    mock.frame[method].mockImplementation(async (...args: unknown[]) => {
      expect(locked).toBe(true);
      return implementation(...args);
    });
  }
  await tick();
  expect(snapshot(native)).toBe(snapshot(server));
  expect(locked).toBe(false);
});

it("queues undo until a lock is available and publishes undo and redo as durable edits", async () => {
  const { server, native, tick } = await setup();
  const initial = snapshot(native);
  await act(async () => { move(native, 20); mock.props!.onChanged!(); });
  await tick();
  const edited = snapshot(native);
  expect(mock.frame.setHistoryState).toHaveBeenLastCalledWith(true, false);
  mock.frame.tryLock.mockResolvedValue(false);
  await act(async () => mock.props!.onHistory!("undo"));
  await tick();
  expect(snapshot(server)).toBe(edited);
  mock.frame.tryLock.mockResolvedValue(true);
  await tick();
  expect(snapshot(native)).toBe(initial);
  expect(snapshot(server)).toBe(initial);
  expect(mock.frame.setHistoryState).toHaveBeenLastCalledWith(false, true);
  await act(async () => mock.props!.onHistory!("redo"));
  await tick();
  expect(snapshot(native)).toBe(edited);
  expect(snapshot(server)).toBe(edited);
  expect(mock.frame.setHistoryState).toHaveBeenLastCalledWith(true, false);
});

it("keeps a read-only renderer locked against editing while still reconciling peers", async () => {
  const { server, native, tick } = await setup({ readOnly: true });
  await act(async () => { move(server, 30); mock.changed(); });
  await tick();
  expect(snapshot(native)).toBe(snapshot(server));
  expect(mock.frame.setReadOnly).toHaveBeenLastCalledWith(true);
  expect(mock.frame.setHistoryState).toHaveBeenLastCalledWith(false, false);
  const before = snapshot(server);
  await act(async () => mock.props!.onHistory!("undo"));
  await tick();
  expect(snapshot(native)).toBe(before);
  expect(snapshot(server)).toBe(before);
});

it("preserves a recovered draft without replaying it into a read-only session", async () => {
  const server = seedKicadDoc(board(10));
  const local = new Y.Doc();
  applyBase64Update(local, updateBase64(server));
  move(local, 20);
  const draft = { doc: updateBase64(local), confirmed: updateBase64(server) };
  const before = snapshot(server);
  const { saved, tick, container } = await setup({ server, draft, readOnly: true });
  await tick();
  expect(saved()).toEqual(draft);
  expect(snapshot(server)).toBe(before);
  expect(mock.saveDraft).not.toHaveBeenCalled();
  expect(container.querySelector("[role=alert]")?.textContent).toContain("session is read-only");
  local.destroy();
});

it("retains durable edits when the server applies them but the acknowledgment is lost", async () => {
  const { server, native, saved, tick } = await setup();
  const online = mock.sync.getMockImplementation()!;
  mock.sync.mockImplementation(async (request: KicadRpcRequest) => {
    const before = snapshot(server);
    const response = await online(request);
    if (snapshot(server) !== before) throw new Error("acknowledgment lost");
    return response;
  });
  await act(async () => { move(native, 20); mock.props!.onChanged!(); });
  await tick();
  expect(snapshot(server)).toBe(snapshot(native));
  expect(saved()).not.toBeNull();
  const confirmed = new Y.Doc();
  applyBase64Update(confirmed, saved()!.confirmed);
  expect(snapshot(confirmed)).not.toBe(snapshot(server));
  confirmed.destroy();
});

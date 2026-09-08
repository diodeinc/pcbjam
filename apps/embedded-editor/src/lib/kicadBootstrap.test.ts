import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { KICAD_WASM_PROTOCOL } from "./kicadWasmProtocol";

it("locks initial snapshots and excludes chrome input only while a render lock is held", async () => {
  const listeners = new Map<string, (event: any) => void>();
  const messages: any[] = [];
  const parent = { postMessage: (message: any) => messages.push(message) };
  const element = { style: {}, dataset: {} };
  const window: any = {
    diodeKicadDiagnostics: {
      record() {},
      start() {},
      end() {},
      failure() {},
      snapshot() {
        return {};
      },
    },
    diodeKicadTheme: { apply() {} },
  };
  const context: any = {
    window,
    parent,
    URLSearchParams,
    WebAssembly,
    setTimeout,
    console,
    location: {
      search: "?session=test&nonce=test",
      origin: "https://registry.test",
    },
    document: { getElementById: () => element },
    addEventListener: (type: string, listener: (event: any) => void) =>
      listeners.set(type, listener),
    FS: { mkdirTree() {}, writeFile() {} },
  };
  runInNewContext(
    readFileSync(
      new URL("../../public/kicad/bootstrap.js", import.meta.url),
      "utf8"
    ),
    context
  );
  let idle = true;
  let locked = false;
  const snapshot = vi.fn(() => {
    expect(locked).toBe(true);
    return JSON.stringify({ added: [], changed: [], removed: [] });
  });
  context.Module = window.Module;
  Object.assign(context.Module, {
    kicadSetReadOnly: vi.fn(() => true),
    kicadOpenFile: () => true,
    kicadOpenFileBusy: () => false,
    kicadCollabSetHistoryMode: vi.fn(() => {
      expect(locked).toBe(true);
      return true;
    }),
    kicadUseWebToolbar: () => true,
    kicadWebToolbarState: () => JSON.stringify({ enabled: true, menus: [] }),
    kicadWebToolbarCommand: vi.fn(() => true),
    kicadWebToolbarChoice: vi.fn(() => true),
    kicadCollabQueueHistoryKey: vi.fn(() => {
      expect(locked).toBe(true);
      return true;
    }),
    kicadCollabBusy: () => false,
    kicadCollabSnapshotItems: snapshot,
    kicadCollabTryLock: () => {
      if (!idle || locked) return false;
      locked = true;
      return true;
    },
    kicadCollabUnlock: () => {
      locked = false;
    },
  });
  context.Module.onRuntimeInitialized();
  let sequence = 0;
  async function request(type: string, payload?: unknown) {
    const requestId = String(++sequence);
    listeners.get("message")!({
      source: parent,
      origin: context.location.origin,
      data: {
        protocol: KICAD_WASM_PROTOCOL,
        session: "test",
        nonce: "test",
        type,
        payload,
        requestId,
      },
    });
    await vi.waitFor(() =>
      expect(
        messages.some((m) =>
          type === "init" ? m.type === "ready" : m.requestId === requestId
        )
      ).toBe(true)
    );
    return messages.find((m) => m.requestId === requestId)?.payload;
  }
  await request("init", {
    board: { filename: "test.kicad_pcb", contents: "(kicad_pcb)" },
    readOnly: false, // Legacy callers cannot bypass the initially locked state.
  });
  expect(context.Module.kicadSetReadOnly.mock.calls).toEqual([[true], [true]]);
  expect(snapshot).toHaveBeenCalledOnce();
  expect(context.Module.kicadCollabSetHistoryMode).toHaveBeenCalledWith(true);
  expect(window.kicadCollab).not.toHaveProperty("onItems");
  expect(locked).toBe(false);

  function inputBlocked(type: string, key = {}) {
    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();
    listeners.get(type)!({ preventDefault, stopImmediatePropagation, ...key });
    expect(preventDefault.mock.calls.length).toBe(
      stopImmediatePropagation.mock.calls.length
    );
    return preventDefault.mock.calls.length > 0;
  }
  idle = false;
  expect(await request("try-lock")).toBe(false);
  expect(inputBlocked("keydown")).toBe(false);
  idle = true;
  expect(await request("try-lock")).toBe(true);
  expect(inputBlocked("keydown")).toBe(true);
  expect(inputBlocked("click")).toBe(true);
  expect(await request("toolbar-state")).toBeNull();
  expect(await request("toolbar-command", { id: 12 })).toBe(false);
  expect(context.Module.kicadWebToolbarCommand).not.toHaveBeenCalled();
  await request("snapshot-items");
  await request("unlock");
  expect(locked).toBe(false);
  expect(inputBlocked("keydown")).toBe(false);
  expect(inputBlocked("click")).toBe(false);
  expect(await request("toolbar-state")).toEqual({ enabled: true, menus: [] });
  // Read-only is independently enforced even without a render lock.
  expect(await request("toolbar-command", { id: 12 })).toBe(false);
  await request("set-read-only", { readOnly: false });
  window.focus = vi.fn();
  expect(await request("toolbar-command", { id: 12 })).toBe(true);
  expect(context.Module.kicadWebToolbarCommand).toHaveBeenCalledWith(12);
  expect(window.focus).toHaveBeenCalledOnce();
  expect(await request("toolbar-choice", { id: 4, selected: 2 })).toBe(true);
  expect(context.Module.kicadWebToolbarChoice).toHaveBeenCalledWith(4, 2);

  const queueHistoryKey = context.Module.kicadCollabQueueHistoryKey;
  expect(queueHistoryKey).not.toHaveBeenCalled();
  const key = {
    code: "KeyY",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };
  expect(inputBlocked("keydown", key)).toBe(false);
  expect(queueHistoryKey).not.toHaveBeenCalled();
  await request("try-lock");
  const historyMessages = () => messages.filter((m) => m.type === "history");
  expect(inputBlocked("keydown", key)).toBe(true);
  expect(queueHistoryKey).toHaveBeenLastCalledWith(
    "KeyY",
    true,
    false,
    false,
    false
  );
  // Native alone matches configured shortcuts and drains intent after unlock.
  expect(historyMessages()).toHaveLength(0);
  expect(inputBlocked("keyup", key)).toBe(true);
  expect(inputBlocked("click")).toBe(true);
  expect(queueHistoryKey).toHaveBeenCalledTimes(1);
  queueHistoryKey.mockReturnValueOnce(false);
  expect(inputBlocked("keydown", { ...key, code: "KeyR" })).toBe(true);
  expect(queueHistoryKey).toHaveBeenCalledTimes(2);
  await request("set-read-only", { readOnly: true });
  expect(inputBlocked("keydown", key)).toBe(true);
  expect(queueHistoryKey).toHaveBeenCalledTimes(2);
  await request("set-read-only", { readOnly: false });
  queueHistoryKey.mockImplementationOnce(() => {
    throw new Error("Native history queue failed");
  });
  expect(inputBlocked("keydown", key)).toBe(true);
  expect(messages.some((m) => m.type === "error")).toBe(true);
  expect(inputBlocked("keydown", key)).toBe(true);
  expect(queueHistoryKey).toHaveBeenCalledTimes(3);
  expect(historyMessages()).toHaveLength(0);
});

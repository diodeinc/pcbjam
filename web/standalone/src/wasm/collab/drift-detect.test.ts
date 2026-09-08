import { afterEach, describe, expect, it, vi } from "vitest";
import { startDriftDetection } from "./drift-detect";
import { seedKicadDoc } from "./model";

vi.mock("@/lib/api", () => ({ reportDrift: vi.fn(), reportDriftBeacon: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe.each(["pcbnew", "eeschema"] as const)("%s drift checkpoints", tool => {
  function fixture() {
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    const source = `(${tool === "pcbnew" ? "kicad_pcb" : "kicad_sch"} (version 20250114))`;
    const doc = seedKicadDoc(source);
    let locked = false;
    const save = vi.fn(() => { expect(locked).toBe(true); });
    const mod = {
      kicadSaveBoard: save,
      kicadSaveSchematic: save,
      kicadCollabTryLock: vi.fn(() => { locked = true; return true; }),
      kicadCollabUnlock: vi.fn(() => { expect(locked).toBe(true); locked = false; }),
    };
    const detector = startDriftDetection({
      doc, mod, tool, slug: "test", targetPath: "test.kicad", everyN: 1,
      win: { FS: { readFile: () => source, unlink: vi.fn() } as unknown as EmscriptenFS },
    });
    const trigger = () => doc.getMap("trigger").set("update", 1);
    const stop = () => { detector.stop(); doc.destroy(); };
    return { events, mod, save, trigger, stop, locked: () => locked };
  }

  it("does not serialize when local input or another renderer prevents a checkpoint", () => {
    const f = fixture();
    f.mod.kicadCollabTryLock.mockReturnValue(false);
    f.trigger();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.mod.kicadCollabUnlock).not.toHaveBeenCalled();
    f.stop();
  });

  it("never treats missing lock exports as permission to serialize", () => {
    const f = fixture();
    delete (f.mod as Partial<typeof f.mod>).kicadCollabUnlock;
    f.trigger();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.mod.kicadCollabTryLock).not.toHaveBeenCalled();
    f.stop();
  });

  it("holds and releases the lock for a normal drift check", () => {
    const f = fixture();
    f.trigger();
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.mod.kicadCollabUnlock).toHaveBeenCalledOnce();
    expect(f.locked()).toBe(false);
    f.stop();
  });

  it("releases the checkpoint even when serialization fails", () => {
    const f = fixture();
    f.save.mockImplementation(() => { throw new Error("writer failed"); });
    f.trigger();
    expect(f.mod.kicadCollabUnlock).toHaveBeenCalledOnce();
    expect(f.locked()).toBe(false);
    f.stop();
  });

  it("uses the same mandatory checkpoint during beforeunload", () => {
    const f = fixture();
    f.events.dispatchEvent(new Event("beforeunload"));
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.mod.kicadCollabUnlock).toHaveBeenCalledOnce();
    f.stop();
  });
});

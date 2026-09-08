import { afterEach, expect, it, vi } from "vitest";
import { withCollabLock } from "./lock";

afterEach(() => vi.useRealTimers());

it("waits for a checkpoint and keeps the lock until async work settles", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  let available = false;
  let finish!: () => void;
  const mod = {
    kicadCollabTryLock: () => available,
    kicadCollabUnlock: () => events.push("unlock"),
  };
  const first = withCollabLock(mod, async () => {
    events.push("first");
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  const second = withCollabLock(mod, () => { events.push("second"); });
  await vi.advanceTimersByTimeAsync(32);
  expect(events).toEqual([]);
  available = true;
  await vi.advanceTimersByTimeAsync(16);
  expect(events).toEqual(["first"]);
  finish();
  await Promise.all([first, second]);
  expect(events).toEqual(["first", "unlock", "second", "unlock"]);
});

it("releases after a throw and refuses later jobs over the failed model", async () => {
  const mod = { kicadCollabTryLock: () => true, kicadCollabUnlock: vi.fn() };
  await expect(withCollabLock(mod, () => { throw new Error("trap"); })).rejects.toThrow("trap");
  const later = vi.fn();
  await expect(withCollabLock(mod, later)).rejects.toThrow("trap");
  expect(later).not.toHaveBeenCalled();
  expect(mod.kicadCollabUnlock).toHaveBeenCalledTimes(1);
});

it("times out without running unlocked work or releasing another owner's lock", async () => {
  vi.useFakeTimers();
  const mod = { kicadCollabTryLock: () => false, kicadCollabUnlock: vi.fn() };
  const run = vi.fn();
  const result = expect(withCollabLock(mod, run)).rejects.toThrow("checkpoint timed out");
  await vi.advanceTimersByTimeAsync(30_016);
  await result;
  expect(run).not.toHaveBeenCalled();
  expect(mod.kicadCollabUnlock).not.toHaveBeenCalled();
});

it("supports pl_editor without lock exports but rejects partial exports", async () => {
  await expect(withCollabLock({}, () => 42)).resolves.toBe(42);
  await expect(withCollabLock({ kicadCollabTryLock: () => true }, () => 42))
    .rejects.toThrow("Incomplete");
});

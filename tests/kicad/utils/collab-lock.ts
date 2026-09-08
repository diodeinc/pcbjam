import type { Page } from "@playwright/test";

/**
 * Direct embind probes obey the same checkpoint contract as the host adapter.
 * The callback is serialized just like page.evaluate: it must be self-contained.
 * Acquire and invoke in ONE browser task, and release even if the probe throws.
 */
export async function collabEvaluate<T, A = undefined>(
  page: Page,
  run: (arg: A) => T | Promise<T>,
  arg?: A,
): Promise<T> {
  return page.evaluate(async ({ source, arg }) => {
    const mod = (window as unknown as { Module: {
      kicadCollabTryLock?: () => boolean;
      kicadCollabUnlock?: () => void;
      kicadCollabBusy?: () => boolean;
    } }).Module;
    // pl_editor has no native checkpoint API. Merged editors must have BOTH
    // exports; this is not a fallback when their acquisition fails.
    if (!mod.kicadCollabTryLock && !mod.kicadCollabUnlock) {
      return (0, eval)(`(${source})`)(arg);
    }
    if (!mod.kicadCollabTryLock || !mod.kicadCollabUnlock) {
      throw new Error("Incomplete native collaboration lock API");
    }
    const deadline = Date.now() + 30_000;
    while (!mod.kicadCollabTryLock()) {
      if (Date.now() >= deadline) throw new Error("Test could not acquire KiCad checkpoint");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    try {
      const result = await (0, eval)(`(${source})`)(arg);
      // An embind return may only mean the coroutine job was queued. Keep
      // ownership through its actual completion, not just its JS return.
      while (mod.kicadCollabBusy?.()) {
        if (Date.now() >= deadline) throw new Error("Native test probe did not settle");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      return result;
    } finally {
      mod.kicadCollabUnlock();
    }
  }, { source: run.toString(), arg });
}

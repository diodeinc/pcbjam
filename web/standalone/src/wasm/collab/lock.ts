/** Editor lock exports are absent on pl_editor, present on the merged editor. */
export interface CollabLockModule {
  kicadCollabTryLock?: () => boolean;
  kicadCollabUnlock?: () => void;
}

const queues = new WeakMap<CollabLockModule, Promise<unknown>>();

/**
 * Serialize host work at a native checkpoint. Unlock may be deferred by C++
 * until a suspended apply finishes; the next TryLock must succeed before the
 * next host job runs. Never treat a failed acquisition as an empty snapshot.
 */
export function withCollabLock<T>(mod: CollabLockModule, run: () => T | Promise<T>): Promise<T> {
  const previous = queues.get(mod) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (!mod.kicadCollabTryLock && !mod.kicadCollabUnlock) return run();
    if (!mod.kicadCollabTryLock || !mod.kicadCollabUnlock) {
      throw new Error("Incomplete KiCad collaboration lock exports");
    }
    const deadline = Date.now() + 30_000;
    while (!mod.kicadCollabTryLock()) {
      if (Date.now() >= deadline) throw new Error("KiCad collaboration checkpoint timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    try {
      return await run();
    } finally {
      mod.kicadCollabUnlock();
    }
  });
  // A failed job is terminal to this queue: do not apply later remote deltas
  // over a model whose previous reconciliation failed. Callers report errors.
  queues.set(mod, next);
  return next;
}

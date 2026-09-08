import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";

let built = false;

export async function loadCollabBundle(page: Page): Promise<void> {
  const tests = path.resolve(__dirname, "../..");
  if (!built) {
    execFileSync("node", ["collab/build.mjs"], { cwd: tests, stdio: "inherit" });
    built = true;
  }
  await page.addScriptTag({ path: path.join(tests, "apps/kicad/collab-bundle-v2.js") });
}

/** The old emit probes keep their assertions, but observe local Yjs updates
 * from the production locked-pull adapter instead of the retired PCB callback. */
export async function captureLocalItems(page: Page, seedText: string): Promise<void> {
  await loadCollabBundle(page);
  await page.evaluate(async (seedText) => {
    const w = window as unknown as {
      Module: never;
      KicadCollabV2: {
        start(mod: never, win: unknown, opts: { room: string; seedText: string }): Promise<void>;
        captureLocalItems(): void;
      };
    };
    await w.KicadCollabV2.start(w.Module, window, { room: crypto.randomUUID(), seedText });
    w.KicadCollabV2.captureLocalItems();
  }, seedText);
}

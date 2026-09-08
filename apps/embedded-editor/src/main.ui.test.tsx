// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { HostConnection } from "./lib/host";

const mock = vi.hoisted(() => ({ mountThemes: [] as (string | undefined)[] }));
// Suppress only main.tsx's entrypoint render; test the exported App with a real root.
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => {} }) }));
vi.mock("./components/SandboxKicadPane", async () => {
  const { useLayoutEffect } = await import("react");
  return { SandboxKicadPane: () => {
    useLayoutEffect(() => { mock.mountThemes.push(document.documentElement.dataset.theme); }, []);
    return <div data-kicad-state="collaborating"><div>board.kicad_pcb</div></div>;
  } };
});
vi.mock("./components/KicadWasmFrame", () => ({ KicadWasmFrame: () => null }));
import { App } from "./main";

const { createRoot } = await vi.importActual<typeof import("react-dom/client")>("react-dom/client");
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  delete document.documentElement.dataset.theme;
  document.body.innerHTML = '<div id="root"></div>';
  const style = document.createElement("style");
  style.textContent = readFileSync("src/style.css", "utf8");
  document.head.append(style);
  root = createRoot(document.getElementById("root")!);
  mock.mountThemes.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  document.head.innerHTML = "";
  delete document.documentElement.dataset.theme;
});
function hostStub() {
  return { send: vi.fn(), dispose: vi.fn() } as unknown as HostConnection;
}

it.each(["light", "dark"] as const)("keeps embedded chrome neutral until open, then mounts in %s", theme => {
  const host = hostStub();
  act(() => root.render(<App host={host} />));
  expect(host.send).toHaveBeenCalledWith("ready");
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(getComputedStyle(document.body).backgroundColor).toBe("transparent");
  expect(getComputedStyle(document.querySelector(".host-wait")!).visibility).toBe("hidden");
  expect(mock.mountThemes).toEqual([]);
  expect(document.querySelector("header, details, a")).toBeNull();
  act(() => host.onTheme("dark"));
  expect(document.documentElement.dataset.theme).toBeUndefined();
  act(() => host.onOpen({ filename: "board.kicad_pcb", readOnly: false, theme }));
  expect(mock.mountThemes).toEqual([theme]);
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(document.querySelector("header")).toBeNull();
  expect(document.querySelector("input[type=file]")).toBeNull();
  const about = document.querySelector("details")!;
  expect(about.open).toBe(false);
  expect(about.querySelector("summary")!.textContent).toBe("About");
  expect(document.querySelectorAll("a")).toHaveLength(1);
  act(() => about.querySelector("summary")!.click());
  expect(about.open).toBe(true);
  expect(about.querySelector("a")!.getAttribute("href")).toBe("./licenses.html");
  expect(about.querySelector("a")!.textContent).toContain("Source");
  const next = theme === "dark" ? "light" : "dark";
  act(() => host.onTheme(next));
  expect(document.documentElement.dataset.theme).toBe(next);
  expect(mock.mountThemes).toEqual([theme]);
});

it("retains standalone branding, file controls and theme switching", () => {
  act(() => root.render(<App host={null} />));
  expect(document.querySelector("header strong")!.textContent).toBe("PCBJam");
  expect(document.querySelector('input[aria-label="Open board"]')!.getAttribute("accept")).toBe(".kicad_pcb");
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("header button")];
  expect(buttons[0].textContent).toBe("Download board");
  expect(buttons[0].disabled).toBe(true);
  expect(document.documentElement.dataset.theme).toBe("light");
  act(() => buttons[1].click());
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(buttons[1].textContent).toBe("Light theme");
  expect(document.querySelector("header details a")!.getAttribute("href")).toBe("./licenses.html");
});

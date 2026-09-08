// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HostConnection, parseIdentity, type Open } from "./lib/host";
import { EditorAbout } from "./components/KicadToolbar";
import { SandboxKicadPane } from "./components/SandboxKicadPane";
import { KicadWasmFrame, type KicadWasmFrameHandle } from "./components/KicadWasmFrame";
import { validateKicadWasmBoard, type KicadWasmBoard } from "./lib/kicadWasmProtocol";
import "./style.css";

function download(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], {type: "text/plain"}));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function App({ host }: { host: HostConnection | null }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [board, setBoard] = useState<KicadWasmBoard | null>(null);
  const [generation, setGeneration] = useState(0);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark" | null>(host ? null : "light");
  const frame = useRef<KicadWasmFrameHandle>(null);
  useLayoutEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  useEffect(() => {
    if (!host) return;
    let opened = false;
    host.onOpen = (value) => {
      // One board per application identity. Host remounts to change boards.
      if (opened) return;
      // Apply the host palette before mounting any native editor descendants.
      document.documentElement.dataset.theme = value.theme;
      opened = true; setTheme(value.theme); setOpen(value);
    };
    host.onPolicy = readOnly => setOpen(value => value ? {...value, readOnly} : value);
    host.onTheme = value => {
      if (!opened) return;
      document.documentElement.dataset.theme = value;
      setTheme(value);
    };
    host.onDisconnect = e => setError(e.message);
    host.send("ready");
    return () => host.dispose();
  }, [host]);
  useEffect(() => {
    if (!dirty || host) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, host]);
  async function load(file?: File) {
    if (!file || (dirty && !confirm("Discard changes that have not been downloaded?"))) return;
    try {
      const next = {filename: file.name, contents: await file.text()};
      validateKicadWasmBoard(next);
      setError(""); setReady(false); setDirty(false); setBoard(next); setGeneration(n => n + 1);
    } catch (e) { setError((e as Error).message); }
  }
  async function save() {
    const editor = frame.current;
    if (!editor || !board) return;
    try {
      if (!(await editor.tryLock())) throw new Error("Finish the current operation before saving.");
      try { download(await editor.saveBoard(), board.filename); setDirty(false); }
      finally { await editor.unlock(); }
    } catch (e) { setError((e as Error).message); }
  }
  return <main className={host ? "embedded" : "standalone"}>
    {!host && <header><strong>PCBJam</strong><span>Board editor</span>
      <label className="file-button">Open board<input aria-label="Open board" type="file" accept=".kicad_pcb" onChange={e => { void load(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <button disabled={!ready} onClick={() => void save()}>Download board{dirty ? " *" : ""}</button>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "Light" : "Dark"} theme</button>
      <EditorAbout />
    </header>}
    {host && open && <EditorAbout />}
    {error && <div role="alert">{error}</div>}
    {host ? open ? <SandboxKicadPane boardPath={open.filename} host={host} readOnly={open.readOnly} /> : <section className="host-wait" role="status">Waiting for host…</section> :
      board ? <KicadWasmFrame key={generation} ref={frame} local initialBoard={board} className="min-h-0 flex-1" onChanged={() => setDirty(true)} onReady={() => {
        void frame.current?.setReadOnly(false).then(() => setReady(true)).catch(e => setError(e.message));
      }} onError={e => { setReady(false); setError(e.message); }} /> :
      <section className="welcome"><h1>Your board. In your browser.</h1><p>Open a KiCad .kicad_pcb file to begin.</p><p>No account, sandbox, or server needed. Files stay on this device.</p><p>Download your edited board before closing. Requires a current Chrome browser with WebAssembly JSPI.</p></section>}
  </main>;
}
try {
  const identity = parseIdentity(location.search, window.parent !== window);
  createRoot(document.getElementById("root")!).render(<App host={identity ? new HostConnection(identity) : null} />);
} catch (error) { document.getElementById("root")!.textContent = (error as Error).message; }

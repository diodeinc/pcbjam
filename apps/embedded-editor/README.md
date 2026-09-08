# Independent PCBJam board editor

GPL-3.0-only. Copyright PCBJam contributors and Diode contributors. No warranty.
Browser coordination extracted from Diode Registry with authorization: native
history locks/queue, Yjs reconciliation, preview rebasing, recovery and diagnostics
live here. No proprietary auth, sandbox client, storage, or UI package is imported.
`src/lib/collab.ts` contains the extracted collaboration helpers; MIT dependency
attributions are in `NOTICE.js` and the generated third-party notices.

## Build (from repository root)

```sh
pnpm -C apps/embedded-editor install --frozen-lockfile
pnpm -C apps/embedded-editor test
PCBJAM_RUNTIME_DIR=/absolute/path/to/installed/kicad \
PCBJAM_RUNTIME_MANIFEST=/absolute/path/to/ARTIFACT.json \
  pnpm -C apps/embedded-editor build
pnpm -C apps/embedded-editor preview
```

Node 22+, pnpm 12.3.4 and `tar`. Runtime directory must contain `wx.js`, `wx-dom.js`,
`kicad_editor.js`, `kicad_editor.wasm`, `images.tar.gz`. The manifest must identify
the published archive. Output renames `images.tar.gz` to `kicad/images.bin` without
changing bytes, preventing static servers from auto-decompressing the resource.
The input manifest identifies
the published runtime's source and archive digest; it is copied unchanged. **No
WASM rebuild** occurs. Do not mix files from different published runtime builds.
The installed runtime used for verification was PCBJam source
`77c522076f0b93854c87428ce01aba34514edbdb`, archive SHA-256
`45e03a65da4e7661f1715668133babc8a0376069449596f3d6daa01b1a325673`.

Serve the entire `dist/` directory as static files, preserving relative paths,
with `.wasm` served as `application/wasm`. Mount at `/` or a subdirectory whose
entry URL ends in `/` or `/index.html`. A modern JSPI-enabled Chrome is required.
No application backend, login, or external fonts are needed. The published runtime
requires cross-origin isolation (SharedArrayBuffer): serve **COOP: same-origin**,
**COEP: require-corp**, and **CORP: cross-origin** (full header names in `_headers`).
For embedding, the host must itself be cross-origin isolated and delegate
`allow="cross-origin-isolated"` to the app iframe; preserve these headers on the
app, native iframe and runtime assets. Vite preview sets these headers.
Use your deployment's CSP `frame-ancestors` to restrict who may embed it; the
application authenticates messages to the exact parent identity in its URL.
For a security boundary, deploy on a separate origin from proprietary services.

`dist/manifest.json` contains `schemaVersion`, `name`, `license`, `protocol`,
`entrypoint`, `source: {directory,commit,dirty}`, `runtime` (input provenance), and
`files: [{path,bytes,sha256}]` (all other output files, including exact app source).
Outputs: `index.html`, `assets/*`, `kicad/*`, `licenses.html`, `LICENSE`,
`NOTICE.js`, `THIRD-PARTY-NOTICES.txt`, `RUNTIME-ARTIFACT.json`, `source.tar`, `source/*`.
Ship all of these; do not distribute only JS/WASM. Exact modified application
sources accompany every distribution; pinned runtime source links include the
recursive KiCad/wxWidgets submodules. Ensure those source links remain accessible
to recipients when redistributing. Dependencies are pinned in the lockfile.

## Standalone

Open without query parameters (top-level window). Open a `.kicad_pcb` file and
use **Download board** to save. Native undo/redo remains local. Unsaved changes
trigger a close warning, but local mode deliberately has no automatic durable
storage: download before closing. Finish active tools before downloading.

Published-runtime limitation observed in Chrome: switching theme can leave the
board canvas incompletely repainted until **Refresh (F5)** is invoked from the
toolbar. Board contents and the current view are retained; no WASM modifications
or synthetic editing commands are used to mask this native repaint issue.

## Embedded capability protocol

URL: `index.html?session=…&nonce=…&parentOrigin=https%3A%2F%2Fhost.example`.
Use unique opaque session/nonce values and exact HTTP(S) parent origin (no path).
All outer messages: `{protocol:'diode-pcbjam-app-v1',session,nonce,type,requestId?,payload?}`.
Both sides must validate `event.source`, `event.origin`, session and nonce.

1. App sends `ready`; host sends `open` with `{filename,readOnly,theme}`. Filename
   is a board basename, theme is `light` or `dark`. One board per identity;
   remount with a fresh identity to switch. Never send paths or credentials.
2. App sends `request`, unique `requestId`, `{method,params?}`. Host responds
   `response`, same requestId, `{result}` (including `undefined`) or `{error:string}`.
3. Methods: `draft-load` → `{doc,confirmed}|null`; `connect` → host preflight and
   connection; `sync` with `{update?,stateVector?,includeContents?}` → existing Yjs
   sync response; `read-project` → basename-keyed contents or null/undefined;
   `draft-merge` with `{doc,confirmed}` → only acknowledge after IndexedDB merge
   transaction commits; `disconnect` → release connection.
4. Notifications: host `invalidate`, `disconnected {message}`, `set-policy
   {readOnly}`, `set-theme {theme}`. App `status {pendingWrites,storageFailed,phase?}`
   informs the host's unload guard. Host owns draft account/sandbox/board isolation
   and merging, plus unload/unmount disconnect. Never clear a preserved draft on
   error. App checks server struct lineage before recovery.

Native RPCs never cross this outer boundary. The app's same-origin native iframe
has a separate random identity and local protocol. Theme/diagnostics inspect only
that local app/renderer pair, not Registry DOM. Hidden rendering cannot block
network sync, which awaits durable draft writes but never native rendering.

## Tests

`pnpm -C apps/embedded-editor test` covers protocol authentication, recovery,
durable-before-send orchestration, native input/history lock and queue invariants,
toolbar payload validation and bounded diagnostics. Native WASM integration
requires the published runtime; unit harnesses do not claim real native coverage.

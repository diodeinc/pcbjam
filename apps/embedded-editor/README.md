# Independent PCBJam board editor

GPL-3.0-only. Copyright PCBJam contributors and Diode contributors. No warranty.
Browser coordination extracted from Diode Registry with authorization: native
history locks/queue, Yjs reconciliation, preview rebasing, recovery and diagnostics
live here. No proprietary auth, sandbox client, storage, or UI package is imported.
`src/lib/collab.ts` contains the extracted collaboration helpers; MIT dependency
attributions are in `NOTICE.js` and the generated third-party notices.

`patches/@pcbjam__shared@0.1.0.patch` patches the **MIT-licensed shared
TypeScript dependency**, applied by `patchedDependencies` in the app's
`pnpm-workspace.yaml` (pnpm 12 ignores package.json's `pnpm` settings) and pinned
in the lockfile. It is not a native KiCad source workaround or a WASM modification.
Its `updateAttrOrder` repair preserves common prefix/suffix Y.Array identities
instead of replacing the entire order: Undo must not delete an unchanged leading
footprint name and restore it after incoming native metadata. It preserves exact
slot order, not atom-first sorting: `fp_text`'s `hide` and stackup's `addsublayer`
can legitimately occur between fields. The patch ships in `source.tar` alongside
the application sources so frozen-lockfile installs reproduce the dependency fix.

**Modification notice — 2026-09-08, Diode contributors:** this is a modified
GPL application, not unmodified upstream PCBJam. Changes include extracted browser
coordination, standalone and authenticated iframe hosting, native toolbar
integration, and verified runtime/source/license packaging. This date is a source
modification date, not a build timestamp; update this notice and `modificationDate`
in `scripts/distribute.mjs` when making subsequent application modifications.

## Build (from repository root)

```sh
pnpm -C apps/embedded-editor install --frozen-lockfile
pnpm -C apps/embedded-editor test
PCBJAM_RUNTIME_DIR=/absolute/path/to/installed/kicad \
PCBJAM_RUNTIME_MANIFEST=/absolute/path/to/ARTIFACT.json \
PCBJAM_RUNTIME_RELEASE_DIR=/absolute/path/to/published/release \
  pnpm -C apps/embedded-editor build
pnpm -C apps/embedded-editor preview
```

Node 22+, pnpm 12.3.4, `tar`, and Python 3 (standard-library ZIP reader only).
Obtain these assets from the **same published native release**, without renaming
or modifying them, and place them in `PCBJAM_RUNTIME_RELEASE_DIR`:
`kicad-wasm.zip`, `SHA256SUMS`, `BUILD-METADATA.txt`, `SOURCE-LICENSES.txt`.
`PCBJAM_RUNTIME_MANIFEST` is the independently reviewed release pin (`ARTIFACT.json`),
requiring `repository` (HTTPS), `archiveSha256` (64 lowercase hex), and full 40-hex
`sourceCommit`, `diodeKicadCommit`, `wxwidgetsCommit` values.

Packaging first checks the archive SHA-256 against that exact pin, then checks
the archive and both text sidecars against `SHA256SUMS`, and checks metadata's
`root_commit`, `kicad_commit`, `wxwidgets_commit` against the corresponding pins.
Malformed/duplicate checksum or metadata entries and missing assets fail closed.
The ZIP must contain exactly `wx.js`, `wx-dom.js`, `kicad_editor.js`,
`kicad_editor.wasm`, `images.tar.gz`, with no duplicate or extra entries.
Verified archive snapshots are the **only** runtime bytes packaged. The existing
`PCBJAM_RUNTIME_DIR` remains supported: if set, each of its five files must equal
the archived bytes; it can be omitted to use the verified release archive directly.
Output renames `images.tar.gz` to `kicad/images.bin` without changing bytes,
preventing static servers from auto-decompressing the resource. Manifest and text
sidecars are copied byte-for-byte, not regenerated. **No WASM rebuild** or runtime
download occurs; no dependency is downloaded from private Registry source.
Temporary extraction uses `TMPDIR` and is cleaned on success or failure. In a
low-disk Linux orb, prefix the command with `TMPDIR=/dev/shm`.

Trust limit: the archive is authenticated only as strongly as the independently
reviewed manifest pin. `SHA256SUMS` is not signed or pinned by that archive digest;
obtain it and the sidecars through a trusted release channel. Checks detect mixed
files and metadata, but cannot authenticate a jointly replaced checksum list and
license text. This is not a cryptographic release signature or a legal compliance
certification. Verify corresponding source availability before redistribution.

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
`entrypoint`, `source: {directory,commit,dirty,modificationDate}`, `runtime` (input provenance), and
`files: [{path,bytes,sha256}]` (all other output files, including exact app source).
Outputs: `index.html`, `assets/*`, `kicad/*`, `licenses.html`, `LICENSE`,
`NOTICE.js`, `THIRD-PARTY-NOTICES.txt`, `RUNTIME-ARTIFACT.json`, `source.tar`, `source/*`.
Also included and linked from `licenses.html`: exact release `SOURCE-LICENSES.txt`,
`BUILD-METADATA.txt`, `SHA256SUMS`, and dated application `MODIFICATIONS.txt`.
The inventory covers every output except `manifest.json` itself, including all
source helpers/tests, native notices, metadata and modification notices.
`SHA256SUMS` describes the original release assets (the ZIP is an input, not shipped
inside the app); use `manifest.json` to check distributed file bytes.
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

Embedded mode keeps a compact filename/status strip and monochrome typography,
without the standalone PCBJam banner. The app owns its palette and uses system
monospace fonts, not the host's licensed font assets. Licensing and exact source
downloads remain available under **About** in both modes. Initial host theme is
applied before mounting the renderer.

Routine captures acquire, snapshot, and release the native lock within one
renderer request; parent messaging and snapshot diffing happen after unlock.
History and remote applies retain their longer locked transaction paths. No
native input is replayed, and no snapshot is taken without the native lock.

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
toolbar payload validation and bounded diagnostics. Collaboration regressions use
the real local branch helpers, untracked server normalization, Undo/Redo and peer
convergence, checking exact footprint and interleaved `fp_text hide` body order
against independently authored KiCad inputs. Native WASM integration
requires the published runtime; unit harnesses do not claim real native coverage.
The same command also runs executable packaging fixture tests: exact valid release,
mixed runtime bytes, wrong archive pin, mixed license/metadata sidecars, inconsistent
root/KiCad/wxWidgets commits, malformed inputs, and complete repeated output
inventory/source/notices. Run just those with
`pnpm -C apps/embedded-editor test scripts/verify-runtime.test.mjs`.
Run `pnpm -C apps/embedded-editor typecheck` separately for TypeScript validation.

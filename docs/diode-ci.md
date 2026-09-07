# Diode CI and releases

The Diode fork builds on `blacksmith-16vcpu-ubuntu-2404`. Pull requests from
forks are deliberately skipped before reaching the paid runner; same-repository
pull requests and `main` pushes use the reusable WASM recipe. Checkout, Node,
cache, and artifact actions are commit-pinned. No workflow accesses PCBJam R2,
Discord, Cloudflare, telemetry, demo, site, staging, or library publishing.
Logs, Playwright results, and screenshots are retained as GitHub artifacts.

Both CI and release build with `BUILD_3D_VIEWER=OFF`, at most 12 compiler jobs,
and a 48 GiB container limit. Cache key epoch `kwasm-v2` includes the root build
input hash, submodule commits, 3D setting, job bound, and `.ci-cache-epoch`.
The ordinary wxWidgets, KiCad, JSPI, coroutine, GAL, web, worker, and contract
suites run. The independent 3D WebGL harness also runs. The six `3D viewer ...`
KiCad suites require `BUILD_3D_VIEWER=ON` and do not skip safely with the stub,
so the OFF workflow explicitly excludes those describes. This is the known
unavailable regression coverage; CI does not claim 3D-viewer integration.

Pushing a trusted `diode-v*` tag in `diodeinc/pcbjam` repeats the exact build and
test recipe, then creates a GitHub Release with no external hosting secret. The
`kicad-wasm.zip` root contains exactly `wx.js`, `wx-dom.js`, `kicad_editor.js`,
`kicad_editor.wasm`, and `images.tar.gz`. It is accompanied by `SHA256SUMS`,
deterministic build metadata (root/submodule commits, toolchain, config), and
corresponding-source/license information. A rerun verifies existing assets and
fails rather than overwriting different bytes.

Repository setup required: enable GitHub Actions, grant the repository access
to Blacksmith's runners, and ensure checkout can read every pinned submodule.
Public HTTPS submodules need no secret; private submodules require repository
checkout authentication to be arranged before enabling these workflows.

## Initial rollout order

1. Publish `diode-wasm` to `diode-inc/kicad` on GitLab and the tested WASM
   port to `diodeinc/wxWidgets`' `master` before publishing the root gitlinks.
   wxWidgets preserves both fork histories while adopting the tested WASM
   source tree. KiCad's native desktop branch remains unchanged.
2. Publish the root integration directly to `diodeinc/pcbjam`'s `main`.
   Run the Blacksmith build and browser tests before tagging.
3. After that build is green, publish a `diode-v*` release tag. Verify the
   downloaded release archive against its published `SHA256SUMS`.
4. Update Registry's installer to pin that release URL and archive digest;
   only then retire the monorepo patch-bundle fallback.

The initial local migration verified source equivalence with the tested
integration and ran packaging/static checks, not a fresh full WASM build.
The first Blacksmith run remains a rollout gate. Screenshot captures are
retained as artifacts; the upstream private R2 baseline comparison is not
part of this fork's CI.

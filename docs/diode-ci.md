# Diode CI and releases

The Diode fork builds on `blacksmith-32vcpu-ubuntu-2404` (32 vCPU, 128 GB RAM).
Three isolated runners compile concurrently: the editor; headless tools and
services; and calculator/layout-editor/Gerber utilities. A fourth runner then
assembles their outputs and runs the combined tests. Only the editor shard
supplies shared runtime resources and sysroot headers. No mutable Docker
volumes or output directories are shared between runners. Pull requests from
forks are deliberately skipped before reaching the paid runner; same-repository
pull requests and `main` pushes use the reusable WASM recipe. Checkout, Node,
cache, and artifact actions are commit-pinned. No workflow accesses PCBJam R2,
Discord, Cloudflare, telemetry, demo, site, staging, or library publishing.
Logs, Playwright results, and screenshots are retained as GitHub artifacts.

Both CI and release build the editor with `BUILD_3D_VIEWER=OFF`. The OCC
service always enables its required real 3D/model libraries. Builds use at most 32 compiler jobs
per runner, and a 110 GiB container limit. Cache key epoch `kwasm-v3` includes
the shard, root build input hash, submodule commits, 3D setting, job bound,
and `.ci-cache-epoch`. Browser suites use 16 workers; performance measurements
remain serial. Tools within each shard stay sequential because their setup
mutates shared dependencies, wxWidgets, and stubs.

Each shard also persists its Docker `.ccache` (bounded to 10 GB) between runs.
The cache restores across source commits for the same Emscripten version;
ccache validates individual compiler inputs before reusing objects. Unique
per-run/attempt/shard keys allow new entries to be saved even after a compile
failure, without treating incomplete WASM output as valid. Cache statistics
are printed in the export step. `no_cache` skips compiler-cache restoration
as well as final output restoration. SDK, dependency, wx test-build, and
browser caches remain separate. A cold run duplicates dependency work across
three runners; warm runs reuse it. This trades additional runner-minutes for
lower wall time; cache-hit rates and timings must be measured in CI.

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

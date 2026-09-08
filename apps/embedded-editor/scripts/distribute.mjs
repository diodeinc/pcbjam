// SPDX-License-Identifier: GPL-3.0-only
import { cp, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { verifyRuntime, runtimeFiles } from "./verify-runtime.mjs";

const app = resolve(import.meta.dirname, "..");
const root = resolve(app, "../..");
const dist = join(app, "dist");
// Validate all release inputs before writing any distribution files.
const { provenance, manifest, sidecars, files } = await verifyRuntime({
  runtime: process.env.PCBJAM_RUNTIME_DIR,
  artifact: process.env.PCBJAM_RUNTIME_MANIFEST,
  release: process.env.PCBJAM_RUNTIME_RELEASE_DIR,
});
await mkdir(join(dist, "kicad"), { recursive: true });
// .bin avoids static servers treating the archive itself as HTTP gzip encoding.
for (const name of runtimeFiles) await writeFile(join(dist, "kicad", name === "images.tar.gz" ? "images.bin" : name), files[name]);
for (const [name, bytes] of Object.entries(sidecars)) await writeFile(join(dist, name), bytes);
await writeFile(join(dist, "kicad/runtime-build.js"), `window.KICAD_BUILD = ${JSON.stringify({
  archiveSha256: provenance.archiveSha256, diodeKicadCommit: provenance.diodeKicadCommit,
  pcbjamCommit: provenance.sourceCommit, wxwidgetsCommit: provenance.wxwidgetsCommit, archiveUrl: provenance.archiveUrl,
})};\n`);

// Ship the exact application sources, including uncommitted edits, so a local
// build never falsely claims its git HEAD alone is corresponding source.
const source = join(dist, "source/apps/embedded-editor");
await rm(join(dist, "source"), { recursive: true, force: true });
await mkdir(source, { recursive: true });
for (const name of ["src", "public", "scripts", "patches", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vite.config.ts", "index.html", "NOTICE.js", "README.md"]) {
  await cp(join(app, name), join(source, name), { recursive: true });
}
await cp(join(root, "LICENSE"), join(dist, "LICENSE"));
await cp(join(root, "LICENSE"), join(dist, "source/LICENSE"));
execFileSync("tar", ["-cf", join(dist, "source.tar"), "-C", join(dist, "source"), "."]);
await cp(join(app, "NOTICE.js"), join(dist, "NOTICE.js"));
// Include the published runtime's provenance and full license notices for all
// bundled JS dependencies (including transitive MIT dependencies).
await writeFile(join(dist, "RUNTIME-ARTIFACT.json"), manifest);
const require = createRequire(join(app, "package.json"));
const packages = ["react", "react-dom", "scheduler", "loose-envify", "js-tokens", "yjs", "lib0", "isomorphic.js", "@pcbjam/shared", "@ts-rest/core", "zod"];
const resolvers = [require];
let notices = await readFile(join(app, "NOTICE.js"), "utf8");
for (const name of packages) {
  let entry;
  for (const resolver of resolvers) {
    try { entry = resolver.resolve(`${name}/package.json`); break; }
    catch { try { entry = resolver.resolve(name); break; } catch {} }
  }
  if (!entry) throw new Error(`Unable to resolve license for ${name}`);
  let dir = resolve(entry, "..");
  while (dir !== "/") {
    try { const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")); if (pkg.name === name) break; } catch {}
    dir = resolve(dir, "..");
  }
  const license = (await readdir(dir)).find(f => /^licen[cs]e(?:\.|$)/i.test(f));
  if (!license) throw new Error(`Missing license for ${name}`);
  resolvers.push(createRequire(join(dir, "package.json")));
  notices += `\n\n=== ${name} ===\n${await readFile(join(dir, license), "utf8")}`;
}
await writeFile(join(dist, "THIRD-PARTY-NOTICES.txt"), notices);
let sourceCommit = null, sourceDirty = true;
try {
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding:"utf8", stdio:["ignore","pipe","ignore"]}).trim();
  sourceDirty = !!execFileSync("git", ["status", "--porcelain", "--", "apps/embedded-editor"], {cwd:root, encoding:"utf8"}).trim();
} catch { /* The shipped source tree is independently buildable without git. */ }
const runtimeSource = `${provenance.repository}/tree/${provenance.sourceCommit}`;
const modificationDate = "2026-09-08";
await writeFile(join(dist, "MODIFICATIONS.txt"), `Modified application by Diode contributors, ${modificationDate}.\nThis GPL-3.0-only application includes extracted browser coordination, standalone and authenticated iframe hosting, native toolbar integration, and verified runtime/source/license packaging. It is not an unmodified upstream application. Exact modified application sources and build instructions accompany this distribution in source.tar. Runtime bytes are unchanged from the pinned release.\n`);
await writeFile(join(dist, "licenses.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>PCBJam licenses and source</title><body><h1>PCBJam board editor</h1><p>Copyright PCBJam contributors and Diode contributors. Distributed under <a href="LICENSE">GNU GPL version 3</a>, WITHOUT ANY WARRANTY.</p><p>Modified by Diode contributors, ${modificationDate}: <a href="MODIFICATIONS.txt">modification notice</a>.</p><p><a href="source.tar" download>Download exact application source</a> · <a href="source/apps/embedded-editor/README.md">Build instructions</a> · <a href="manifest.json">Build manifest</a> · <a href="THIRD-PARTY-NOTICES.txt">JavaScript third-party licenses</a> · <a href="SOURCE-LICENSES.txt">Native runtime source and licenses</a> · <a href="BUILD-METADATA.txt">Native build metadata</a> · <a href="SHA256SUMS">Release checksums</a></p><p>Application sources are supplied under source/apps/embedded-editor, including all modifications in this build. <a href="https://github.com/diodeinc/pcbjam">PCBJam repository</a>.</p><p><a href="${runtimeSource}">Pinned runtime corresponding source and recursive submodules</a>. <a href="RUNTIME-ARTIFACT.json">Runtime provenance</a>. Reproduce the runtime using that revision's build scripts; application builds reuse the published runtime, never rebuild WASM.</p></body></html>`);
async function inventory(dir, prefix = "") {
  const result = [];
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    const path = prefix + entry.name;
    if (path === "manifest.json") continue; // No stale self-hash on repeated packaging.
    if (entry.isDirectory()) result.push(...await inventory(join(dir, entry.name), path + "/"));
    else { const bytes = await readFile(join(dir, entry.name)); result.push({path, bytes:bytes.length, sha256:createHash("sha256").update(bytes).digest("hex")}); }
  }
  return result.sort((a,b) => a.path.localeCompare(b.path));
}
await writeFile(join(dist, "manifest.json"), JSON.stringify({
  schemaVersion:1, name:"@pcbjam/embedded-editor", license:"GPL-3.0-only", protocol:"diode-pcbjam-app-v1",
  entrypoint:"index.html", source:{directory:"source/apps/embedded-editor", commit:sourceCommit, dirty:sourceDirty, modificationDate},
  runtime:provenance, files:await inventory(dist),
}, null, 2));
console.log(`Static editor distribution: ${dist}`);

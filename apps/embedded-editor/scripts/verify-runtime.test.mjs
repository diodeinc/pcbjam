// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, expect, test } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runtimeFiles, verifyRuntime } from "./verify-runtime.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let directory, input, pin;
async function savePin() { await writeFile(input.artifact, JSON.stringify(pin)); }
async function saveSums() {
  const lines = await Promise.all(["kicad-wasm.zip", "BUILD-METADATA.txt", "SOURCE-LICENSES.txt"].map(async name => `${hash(await readFile(join(input.release, name)))}  ${name}\n`));
  await writeFile(join(input.release, "SHA256SUMS"), lines.join(""));
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pcbjam-packaging-test-"));
  input = { runtime: join(directory, "installed"), artifact: join(directory, "ARTIFACT.json"), release: join(directory, "release") };
  await mkdir(input.runtime);
  await mkdir(input.release);
  for (const name of runtimeFiles) await writeFile(join(input.runtime, name), `fixture bytes: ${name}\n`);
  execFileSync("python3", ["-c", `
import pathlib, sys, zipfile
with zipfile.ZipFile(sys.argv[2], 'w') as archive:
    for file in pathlib.Path(sys.argv[1]).iterdir():
        archive.write(file, file.name)
`, input.runtime, join(input.release, "kicad-wasm.zip")]);
  pin = { sourceCommit: "1".repeat(40), diodeKicadCommit: "2".repeat(40), wxwidgetsCommit: "3".repeat(40), repository: "https://github.com/diodeinc/pcbjam", archiveSha256: hash(await readFile(join(input.release, "kicad-wasm.zip"))) };
  await savePin();
  await writeFile(join(input.release, "BUILD-METADATA.txt"), `root_commit=${pin.sourceCommit}\nkicad_commit=${pin.diodeKicadCommit}\nwxwidgets_commit=${pin.wxwidgetsCommit}\nemscripten_version=fixture\n`);
  await writeFile(join(input.release, "SOURCE-LICENSES.txt"), "Fixture license notices\n");
  await saveSums();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("accepts exact archive and sidecars, with or without installed inputs", async () => {
  for (const runtime of [input.runtime, undefined]) {
    const verified = await verifyRuntime({ ...input, runtime });
    for (const name of runtimeFiles) expect(verified.files[name]).toEqual(await readFile(join(input.runtime, name)));
    for (const [name, bytes] of Object.entries(verified.sidecars)) expect(bytes).toEqual(await readFile(join(input.release, name)));
    expect(verified.manifest).toEqual(await readFile(input.artifact));
  }
});
test.each(runtimeFiles)("rejects mixed installed %s", async name => {
  await writeFile(join(input.runtime, name), "other release");
  await expect(verifyRuntime(input)).rejects.toThrow(`Installed runtime mismatch: ${name}`);
});
test("rejects archive whose checksum list was rewritten but pin was not", async () => {
  await writeFile(join(input.release, "kicad-wasm.zip"), "other archive");
  await saveSums();
  await expect(verifyRuntime(input)).rejects.toThrow("Pinned archive digest mismatch");
});
test.each(["BUILD-METADATA.txt", "SOURCE-LICENSES.txt"])("rejects mixed sidecar %s", async name => {
  await writeFile(join(input.release, name), "other release");
  await expect(verifyRuntime(input)).rejects.toThrow(`SHA256SUMS mismatch: ${name}`);
});
test.each(["root_commit", "kicad_commit", "wxwidgets_commit"])("rejects inconsistent %s even with matching sidecar checksum", async key => {
  const path = join(input.release, "BUILD-METADATA.txt");
  await writeFile(path, (await readFile(path, "utf8")).replace(new RegExp(`${key}=[^\\n]+`), `${key}=${"4".repeat(40)}`));
  await saveSums();
  await expect(verifyRuntime(input)).rejects.toThrow(`Build metadata mismatch: ${key}`);
});
test("rejects duplicate checksum entries", async () => {
  const path = join(input.release, "SHA256SUMS");
  const sums = await readFile(path, "utf8");
  await writeFile(path, sums + sums.split("\n")[0] + "\n");
  await expect(verifyRuntime(input)).rejects.toThrow("duplicate SHA256SUMS");
});
test("rejects missing release assets", async () => {
  await rm(join(input.release, "SOURCE-LICENSES.txt"));
  await expect(verifyRuntime(input)).rejects.toThrow("ENOENT");
});
test("rejects missing pins and release directory", async () => {
  await expect(verifyRuntime({ ...input, release: undefined })).rejects.toThrow("PCBJAM_RUNTIME_RELEASE_DIR");
  delete pin.wxwidgetsCommit;
  await savePin();
  await expect(verifyRuntime(input)).rejects.toThrow("Invalid manifest wxwidgetsCommit");
});
test("rejects ambiguous archive members even if pinned", async () => {
  execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], 'a'); z.writestr('../escape', 'bad'); z.close()", join(input.release, "kicad-wasm.zip")]);
  pin.archiveSha256 = hash(await readFile(join(input.release, "kicad-wasm.zip")));
  await savePin();
  await saveSums();
  await expect(verifyRuntime(input)).rejects.toThrow("Unexpected or duplicate runtime archive members");
});
test("packages exact notices, sources and a complete repeatable inventory", async () => {
  const app = resolve(import.meta.dirname, "..");
  const copy = join(directory, "apps/embedded-editor");
  await mkdir(copy, { recursive: true });
  for (const entry of await readdir(app)) {
    if (!["dist", "node_modules"].includes(entry)) await cp(join(app, entry), join(copy, entry), { recursive: true });
  }
  await cp(resolve(app, "../../LICENSE"), join(directory, "LICENSE"));
  await symlink(join(app, "node_modules"), join(copy, "node_modules"));
  const env = { ...process.env, PCBJAM_RUNTIME_DIR: input.runtime, PCBJAM_RUNTIME_MANIFEST: input.artifact, PCBJAM_RUNTIME_RELEASE_DIR: input.release };
  const original = await readFile(join(input.runtime, "wx.js"));
  await writeFile(join(input.runtime, "wx.js"), "mixed runtime");
  expect(() => execFileSync(process.execPath, [join(copy, "scripts/distribute.mjs")], { env, stdio: "pipe" })).toThrow("Installed runtime mismatch");
  await expect(readFile(join(copy, "dist/kicad/wx.js"))).rejects.toThrow("ENOENT");
  await writeFile(join(input.runtime, "wx.js"), original);
  for (let run = 0; run < 2; run++) {
    if (run === 0) execFileSync("pnpm", ["-C", copy, "build"], { env, stdio: "pipe" });
    else execFileSync(process.execPath, [join(copy, "scripts/distribute.mjs")], { env });
    const dist = join(copy, "dist");
    const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
    expect(manifest.files.some(f => f.path.endsWith("deleted-source.txt"))).toBe(false);
    const paths = (await readdir(dist, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(dist.length + 1)).filter(p => p !== "manifest.json").sort();
    expect(manifest.files.map(f => f.path).sort()).toEqual(paths);
    for (const file of manifest.files) {
      const bytes = await readFile(join(dist, file.path));
      expect(file.sha256).toBe(hash(bytes));
      expect(file.bytes).toBe(bytes.length);
    }
    const html = await readFile(join(dist, "licenses.html"), "utf8");
    for (const name of ["SOURCE-LICENSES.txt", "BUILD-METADATA.txt", "SHA256SUMS"]) {
      expect(await readFile(join(dist, name))).toEqual(await readFile(join(input.release, name)));
      expect(html).toContain(`href="${name}"`);
    }
    expect(await readFile(join(dist, "RUNTIME-ARTIFACT.json"))).toEqual(await readFile(input.artifact));
    expect(await readFile(join(dist, "kicad/images.bin"))).toEqual(await readFile(join(input.runtime, "images.tar.gz")));
    expect(html).toContain("2026-09-08");
    expect(html).toContain('href="MODIFICATIONS.txt"');
    const tar = execFileSync("tar", ["-tf", join(dist, "source.tar")], { encoding: "utf8" });
    for (const name of ["verify-runtime.mjs", "verify-runtime.test.mjs", "distribute.mjs"]) {
      const path = `apps/embedded-editor/scripts/${name}`;
      expect(tar).toContain(path);
      expect(await readFile(join(dist, "source", path))).toEqual(await readFile(join(app, "scripts", name)));
    }
    if (run === 0) await writeFile(join(dist, "source/deleted-source.txt"), "stale source must not survive repackaging");
  }
}, 20000);

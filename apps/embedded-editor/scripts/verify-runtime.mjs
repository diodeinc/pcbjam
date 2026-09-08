// SPDX-License-Identifier: GPL-3.0-only
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const runtimeFiles = ["wx.js", "wx-dom.js", "kicad_editor.js", "kicad_editor.wasm", "images.tar.gz"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Return verified snapshots, never paths that could change between checking and copying.
export async function verifyRuntime({ runtime, artifact, release }) {
  if (!artifact || !release) throw new Error("Set PCBJAM_RUNTIME_MANIFEST to ARTIFACT.json and PCBJAM_RUNTIME_RELEASE_DIR to the published release assets. PCBJAM_RUNTIME_DIR is optional and, if supplied, must match the archive exactly.");
  const manifest = await readFile(artifact);
  const provenance = JSON.parse(manifest);
  for (const key of ["sourceCommit", "diodeKicadCommit", "wxwidgetsCommit"]) {
    if (!/^[a-f0-9]{40}$/.test(provenance[key])) throw new Error(`Invalid manifest ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(provenance.archiveSha256)) throw new Error("Invalid manifest archiveSha256");
  if (typeof provenance.repository !== "string" || !/^https:\/\/[\w./-]+$/.test(provenance.repository)) throw new Error("Invalid manifest repository");
  const archive = await readFile(join(release, "kicad-wasm.zip"));
  if (sha256(archive) !== provenance.archiveSha256) throw new Error("Pinned archive digest mismatch");
  const sidecars = {};
  for (const name of ["SHA256SUMS", "BUILD-METADATA.txt", "SOURCE-LICENSES.txt"]) sidecars[name] = await readFile(join(release, name));
  const sums = new Map();
  for (const line of sidecars["SHA256SUMS"].toString("utf8").trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) [ *](kicad-wasm\.zip|BUILD-METADATA\.txt|SOURCE-LICENSES\.txt)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error("Invalid or duplicate SHA256SUMS entry");
    sums.set(match[2], match[1]);
  }
  for (const [name, bytes] of Object.entries({ "kicad-wasm.zip": archive, "BUILD-METADATA.txt": sidecars["BUILD-METADATA.txt"], "SOURCE-LICENSES.txt": sidecars["SOURCE-LICENSES.txt"] })) {
    if (sums.get(name) !== sha256(bytes)) throw new Error(`SHA256SUMS mismatch: ${name}`);
  }
  const metadata = new Map();
  for (const line of sidecars["BUILD-METADATA.txt"].toString("utf8").trimEnd().split("\n")) {
    const match = /^([^=]+)=(.*)$/.exec(line);
    if (!match || metadata.has(match[1])) throw new Error("Invalid or duplicate build metadata");
    metadata.set(match[1], match[2]);
  }
  for (const [key, pin] of [["root_commit", "sourceCommit"], ["kicad_commit", "diodeKicadCommit"], ["wxwidgets_commit", "wxwidgetsCommit"]]) {
    if (metadata.get(key) !== provenance[pin]) throw new Error(`Build metadata mismatch: ${key}`);
  }
  const scratch = await mkdtemp(join(tmpdir(), "pcbjam-runtime-"));
  try {
    await writeFile(join(scratch, "archive.zip"), archive);
    // Python's standard-library ZIP reader checks CRCs. Never extract arbitrary paths,
    // symlinks or ambiguous duplicate members, even from a pinned archive.
    execFileSync("python3", ["-c", `
import pathlib, sys, zipfile
directory = pathlib.Path(sys.argv[1])
names = sys.argv[2:]
with zipfile.ZipFile(directory / 'archive.zip') as archive:
    if sorted(archive.namelist()) != sorted(names):
        raise ValueError('Unexpected or duplicate runtime archive members')
    for name in names:
        (directory / name).write_bytes(archive.read(name))
`, scratch, ...runtimeFiles], { stdio: ["ignore", "pipe", "pipe"] });
    const files = {};
    for (const name of runtimeFiles) {
      files[name] = await readFile(join(scratch, name));
      if (runtime && !(await readFile(join(runtime, name))).equals(files[name])) throw new Error(`Installed runtime mismatch: ${name}`);
    }
    return { provenance, manifest, sidecars, files };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

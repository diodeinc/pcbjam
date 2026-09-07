#!/usr/bin/env python3
"""Create deterministic Diode release assets for the Registry installer."""

from __future__ import annotations

import hashlib
import pathlib
import subprocess
import sys
import zipfile

FILES = ("wx.js", "wx-dom.js", "kicad_editor.js", "kicad_editor.wasm", "images.tar.gz")


def git(*args: str) -> str:
    return subprocess.check_output(("git", *args), text=True).strip()


def package(source: pathlib.Path, destination: pathlib.Path) -> None:
    missing = [name for name in FILES if not (source / name).is_file()]
    if missing:
        raise FileNotFoundError("missing required release files: " + ", ".join(missing))
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / "kicad-wasm.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for name in FILES:
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            out.writestr(info, (source / name).read_bytes(), compresslevel=9)

    emscripten = "unknown"
    for line in pathlib.Path("scripts/common/versions.sh").read_text().splitlines():
        if line.startswith('export EMSCRIPTEN_VERSION='):
            emscripten = line.split("=", 1)[1].strip('"')
    metadata = (
        f"root_commit={git('rev-parse', 'HEAD')}\n"
        f"kicad_commit={git('-C', 'kicad', 'rev-parse', 'HEAD')}\n"
        f"wxwidgets_commit={git('-C', 'wxwidgets', 'rev-parse', 'HEAD')}\n"
        f"pcbjam_shared_commit={git('-C', 'web/pcbjam-shared', 'rev-parse', 'HEAD')}\n"
        f"emscripten_version={emscripten}\nBUILD_3D_VIEWER=OFF\nparallel_jobs=12\n"
    )
    (destination / "BUILD-METADATA.txt").write_text(metadata)
    (destination / "SOURCE-LICENSES.txt").write_text(
        "PCBJam: GNU GPL v3. KiCad and wxWidgets notices follow below.\n"
        "Corresponding source: https://github.com/diodeinc/pcbjam/tree/"
        + git("rev-parse", "HEAD") + "\n"
        "Pinned KiCad and wxWidgets corresponding-source commits and the exact "
        "toolchain/configuration are recorded in BUILD-METADATA.txt.\n"
        + "".join(
            f"\n--- {path} ---\n" + pathlib.Path(path).read_text()
            for path in (
                "LICENSE", "kicad/LICENSE", "kicad/LICENSE.README",
                "wxwidgets/docs/licence.txt", "wxwidgets/docs/lgpl.txt",
            )
        )
    )
    assets = (archive, destination / "BUILD-METADATA.txt", destination / "SOURCE-LICENSES.txt")
    sums = "".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in assets)
    (destination / "SHA256SUMS").write_text(sums)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} INPUT_DIR OUTPUT_DIR")
    package(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))

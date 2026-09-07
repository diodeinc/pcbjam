import pathlib
import tempfile
import unittest
import zipfile
from unittest import mock

import package_kicad_wasm as subject


class PackageTest(unittest.TestCase):
    def test_missing_file_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(FileNotFoundError, "wx.js"):
                subject.package(pathlib.Path(tmp), pathlib.Path(tmp) / "out")

    @mock.patch.object(subject, "git", return_value="a" * 40)
    def test_archive_is_exact_deterministic_and_hashed(self, _git):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source = root / "input"
            source.mkdir()
            for name in subject.FILES:
                (source / name).write_bytes(("content:" + name).encode())
            first, second = root / "first", root / "second"
            subject.package(source, first)
            subject.package(source, second)
            self.assertEqual((first / "kicad-wasm.zip").read_bytes(),
                             (second / "kicad-wasm.zip").read_bytes())
            with zipfile.ZipFile(first / "kicad-wasm.zip") as archive:
                self.assertEqual(archive.namelist(), list(subject.FILES))
                self.assertTrue(all("/" not in name for name in archive.namelist()))
            for line in (first / "SHA256SUMS").read_text().splitlines():
                digest, name = line.split("  ")
                self.assertEqual(digest, __import__("hashlib").sha256((first / name).read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()

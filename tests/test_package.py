"""Exercise actual build outputs in an isolated checkout, including local-file exclusions."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("module.json", "package.json", "README.md", "LICENSE", "LICENSE-PF2E", "NOTICE"):
            shutil.copyfile(ROOT / name, self.root / name)
        for name in ("scripts", "docs", "tools", "styles", "lang"):
            (self.root / name).mkdir()
        for folder, pattern in (("scripts", "*.js"), ("docs", "*.md"), ("tools", "package.py"), ("styles", "*.css"), ("lang", "*.json")):
            for source in (ROOT / folder).glob(pattern):
                shutil.copyfile(source, self.root / folder / source.name)
        self.source_manifest = (self.root / "module.json").read_bytes()

    def build(self, *args):
        return subprocess.run([sys.executable, str(self.root / "tools/package.py"), *args],
                              capture_output=True, text=True)

    def test_release_assets_agree_and_exclude_local_files(self):
        for name in (".env", ".local/dropbox/module.json", "tools/publish_dropbox.py",
                     ".playwright-cli/player.log", "scripts/debug.log", "dist/old.zip"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("PRIVATE_TEST_SENTINEL")
        for tag in ("v0.2.3", "0.2.3"):
            with self.subTest(tag=tag):
                result = self.build("--repository", "CircusGM/test-module", "--tag", tag)
                self.assertEqual(result.returncode, 0, result.stderr)
                manifest_bytes = (self.root / "dist/module.json").read_bytes()
                manifest = json.loads(manifest_bytes)
                self.assertEqual(manifest["version"], "0.2.3")
                dependencies = {entry["id"]: entry for entry in manifest["relationships"]["requires"]}
                self.assertEqual(dependencies["lib-wrapper"]["compatibility"]["minimum"], "1.13.5.1")
                self.assertEqual(manifest["manifest"], "https://github.com/CircusGM/test-module/releases/latest/download/module.json")
                self.assertEqual(manifest["download"], f"https://github.com/CircusGM/test-module/releases/download/{tag}/module.zip")
                self.assertNotIn(b"#{", manifest_bytes)
                with ZipFile(self.root / "dist/module.zip") as archive:
                    expected = {"module.json", "README.md", "LICENSE", "LICENSE-PF2E", "NOTICE"}
                    expected.update(str(p.relative_to(self.root)) for p in (self.root / "scripts").glob("*.js"))
                    expected.update(str(p.relative_to(self.root)) for p in (self.root / "docs").glob("*.md"))
                    expected.update(str(p.relative_to(self.root)) for p in (self.root / "styles").glob("*.css"))
                    expected.update(str(p.relative_to(self.root)) for p in (self.root / "lang").glob("*.json"))
                    self.assertEqual(set(archive.namelist()), expected)
                    self.assertEqual(dependencies["pf2e-toolbelt"]["compatibility"]["minimum"], "3.56.3")
                    self.assertEqual(manifest["compatibility"]["maximum"], "14")
                    self.assertEqual(archive.read("module.json"), manifest_bytes)
                    for name in archive.namelist():
                        self.assertNotIn(b"PRIVATE_TEST_SENTINEL", archive.read(name))
                self.assertEqual((self.root / "module.json").read_bytes(), self.source_manifest)

    def test_local_build_has_real_version_and_no_update_urls(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / "dist/module.json").read_text())
        self.assertEqual(manifest["version"], json.loads((self.root / "package.json").read_text())["version"])
        self.assertTrue({"url", "manifest", "download"}.isdisjoint(manifest))

    def test_invalid_release_parameters_fail_without_building(self):
        for args in (("--tag", "v1.0.0"), ("--repository", "CircusGM/repo"),
                     ("--repository", "bad repo", "--tag", "v1.0.0"),
                     ("--repository", "CircusGM/repo", "--tag", "latest")):
            with self.subTest(args=args):
                self.assertNotEqual(self.build(*args).returncode, 0)
                self.assertFalse((self.root / "dist/module.zip").exists())

    def test_symlink_in_packaged_directory_is_rejected(self):
        (self.root / "private.txt").write_text("PRIVATE_TEST_SENTINEL")
        (self.root / "scripts/secret.js").symlink_to(self.root / "private.txt")
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to package", result.stderr)
        self.assertFalse((self.root / "dist/module.zip").exists())


if __name__ == "__main__":
    unittest.main()

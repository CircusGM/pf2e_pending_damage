"""Build Foundry release assets from the source manifest without modifying it."""
import argparse
import json
import re
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", help="GitHub owner/repository for a release build")
    parser.add_argument("--tag", help="Release tag, e.g. v0.1.1 or 0.1.1")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    if bool(args.repository) != bool(args.tag):
        parser.error("--repository and --tag must be supplied together")
    if args.repository and not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        parser.error("repository must be owner/repository")

    manifest = json.loads((ROOT / "module.json").read_text())
    version = args.tag.removeprefix("v") if args.tag else json.loads((ROOT / "package.json").read_text())["version"]
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?", version):
        parser.error("version must be major.minor.patch with an optional prerelease suffix")
    manifest["version"] = version
    if args.repository:
        url = f"https://github.com/{args.repository}"
        manifest.update(
            url=url,
            manifest=f"{url}/releases/latest/download/module.json",
            download=f"{url}/releases/download/{args.tag}/module.zip",
        )
    else:
        # Local builds are installable, but have no published update/download URLs.
        for field in ("url", "manifest", "download"):
            manifest.pop(field, None)
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode()
    if b"#{" in manifest_bytes:
        parser.error("unresolved template value in release manifest")

    # Explicit allowlist: never archive the repository recursively or follow symlinks.
    files = [ROOT / name for name in ("README.md", "LICENSE", "LICENSE-PF2E", "NOTICE")]
    files += sorted((ROOT / "scripts").glob("*.js"))
    files += sorted((ROOT / "docs").glob("*.md"))
    files += sorted((ROOT / "styles").glob("*.css"))
    files += sorted((ROOT / "lang").glob("*.json"))
    for file in files:
        if file.is_symlink() or ROOT not in file.resolve().parents:
            parser.error(f"refusing to package symlink or external file: {file.name}")
    assets = manifest["esmodules"] + manifest.get("styles", []) + [lang["path"] for lang in manifest.get("languages", [])]
    for entry in assets:
        if ROOT / entry not in files:
            parser.error(f"module entry point is missing from the package: {entry}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = args.output_dir / "module.zip"
    with ZipFile(archive_path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("module.json", manifest_bytes)
        for file in files:
            archive.write(file, file.relative_to(ROOT))
    (args.output_dir / "module.json").write_bytes(manifest_bytes)
    print(archive_path)


if __name__ == "__main__":
    main()

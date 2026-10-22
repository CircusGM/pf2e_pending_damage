"""Upload a test build to Dropbox without publishing a GitHub release.

The zip is the GitHub release build, so an installed copy keeps updating from
GitHub releases; only the install manifest, whose URL stays the same across
versions, points to Dropbox. Credentials come from the local Dropbox helper
(DROPBOX_HELPER, default ~/.codex/skills/dropbox/scripts), never from this repository.
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
FOLDER = "/pf2e-pending-damage"
REPOSITORY = "CircusGM/pf2e_pending_damage"
HELPER = Path(os.environ.get("DROPBOX_HELPER", Path.home() / ".codex/skills/dropbox/scripts"))


def numeric(version):
    return tuple(int(part) for part in version.split("-")[0].split("."))


def main():
    if not (HELPER / "upload_and_share.py").is_file():
        sys.exit(f"Dropbox helper not found in {HELPER}; set DROPBOX_HELPER")
    sys.path.insert(0, str(HELPER))
    import upload_and_share as dropbox

    version = json.loads((ROOT / "package.json").read_text())["version"]
    # Foundry only offers an update to a higher version, so stay ahead of GitHub releases.
    with urllib.request.urlopen(f"https://api.github.com/repos/{REPOSITORY}/releases", timeout=30) as response:
        released = [release["tag_name"].removeprefix("v") for release in json.loads(response.read())]
    newest = max(released, key=numeric, default="0.0.0")
    if numeric(version) <= numeric(newest):
        sys.exit(f"version {version} must be higher than the GitHub release {newest}")
    manifest_path = f"{FOLDER}/module.json"
    zip_path = f"{FOLDER}/pf2e-pending-damage-{version}.zip"
    token = dropbox.load_token()

    def put(path, data):
        args = {"path": path, "mode": "overwrite", "autorename": False, "mute": True}
        request = urllib.request.Request(f"{dropbox.CONTENT_API}/files/upload", data=data, method="POST", headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/octet-stream",
            "Dropbox-API-Arg": json.dumps(args, separators=(",", ":")),
        })
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read())

    # Shared links belong to a path, so create them before uploading the real files.
    for path in (manifest_path, zip_path):
        try:
            dropbox.api_json(token, "files/get_metadata", {"path": path})
        except RuntimeError:
            put(path, b"placeholder")
    manifest_url, zip_url = (dropbox.direct_download_url(dropbox.create_or_reuse_shared_link(token, path)["url"])
                             for path in (manifest_path, zip_path))

    with tempfile.TemporaryDirectory() as directory:
        out = Path(directory)
        subprocess.run([sys.executable, str(ROOT / "tools/package.py"), "--output-dir", str(out),
                        "--repository", REPOSITORY, "--tag", version], check=True, stdout=subprocess.DEVNULL)
        put(zip_path, (out / "module.zip").read_bytes())
        # Only the install manifest points to Dropbox; the installed module updates from GitHub.
        manifest = json.loads((out / "module.json").read_text())
        manifest.update(manifest=manifest_url, download=zip_url)
        put(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode())
    print(json.dumps({"version": version, "manifest": manifest_url, "download": zip_url}, indent=2))


if __name__ == "__main__":
    main()

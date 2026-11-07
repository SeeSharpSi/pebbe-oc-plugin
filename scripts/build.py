#!/usr/bin/env python3
"""Build a deterministic, plugin-only Pebble PBW using Python's standard library."""

import json
import os
from pathlib import Path, PurePosixPath
import sys
import tempfile
import uuid
import zipfile


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "build" / "pebble-opencode.pbw"
FIXED_ZIP_TIME = (2020, 1, 1, 0, 0, 0)


def fail(message):
    raise SystemExit(message)


def project_file(root, value):
    if not isinstance(value, str) or not value:
        fail("plugin script and configPage must be project-relative paths")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value or ":" in value:
        fail(f"unsafe project path: {value!r}")
    resolved_root = root.resolve()
    resolved = (root / Path(*path.parts)).resolve()
    if not resolved.is_relative_to(resolved_root):
        fail(f"project path escapes project directory: {value!r}")
    if not resolved.is_file():
        fail(f"required plugin asset is missing: {value}")
    return resolved


def build():
    try:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read package.json: {exc}")
    pebble = package.get("pebble")
    if not isinstance(pebble, dict):
        fail("package.json needs a pebble manifest")
    if pebble.get("projectType") != "plugin":
        fail("only plugin-only projects are supported")
    if pebble.get("manifestVersion", 2) != 2:
        fail("manifestVersion must be 2")
    try:
        uuid.UUID(pebble.get("uuid", ""))
    except (ValueError, AttributeError, TypeError):
        fail("pebble.uuid must be a valid UUID")

    plugin = pebble.get("plugin")
    if not isinstance(plugin, dict):
        fail("pebble.plugin is required")
    if not isinstance(plugin.get("description"), str) or not plugin["description"]:
        fail("pebble.plugin.description is required")
    if not isinstance(plugin.get("sources"), list) or not plugin["sources"]:
        fail("pebble.plugin.sources must be a non-empty list")
    if not isinstance(plugin.get("actions"), list) or not plugin["actions"]:
        fail("pebble.plugin.actions must be a non-empty list")
    script = plugin.get("script")
    config = pebble.get("configPage")
    paths = [(script, project_file(ROOT, script)), (config, project_file(ROOT, config))]
    if script == config:
        fail("plugin script and configPage must be distinct assets")

    display_name = pebble.get("displayName")
    if not isinstance(display_name, str) or not display_name:
        fail("pebble.displayName is required")
    appinfo = dict(pebble)
    appinfo.update({
        "manifestVersion": 2,
        "shortName": display_name,
        "longName": display_name,
        "companyName": package.get("author", ""),
        "versionLabel": package.get("version", ""),
        "sdkVersion": "3",
        "resources": {"media": []},
        "watchapp": {"watchface": False},
    })
    appinfo_bytes = (json.dumps(appinfo, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(dir=OUTPUT.parent, prefix=".pebble-opencode-", delete=False) as tmp:
            temp_name = tmp.name
        with zipfile.ZipFile(temp_name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in [("appinfo.json", appinfo_bytes)] + [
                (name, path.read_bytes()) for name, path in paths
            ]:
                info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o100644 & 0xFFFF) << 16
                archive.writestr(info, data)
        os.replace(temp_name, OUTPUT)
        temp_name = None
    finally:
        if temp_name is not None:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
    print(f"packaged {OUTPUT}")


if __name__ == "__main__":
    build()

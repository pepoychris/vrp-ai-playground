"""Compose the published README/product stills from the live Playwright captures.

``tools/demos/capture_screenshots.mjs`` writes 2x full-page frames into
``tools/demos/.frames/screens`` together with a manifest. This module turns them into the
PNGs the README and the project site publish:

* the sticky header band recorded in the manifest is cropped away, so no capture carries a
  duplicated or overlapping top bar;
* the 2x capture is downsampled to the published width, which keeps the text crisp without
  shipping a multi-megabyte PNG;
* a hard height cap keeps a long dashboard from turning into a wall of pixels.

The raw frames are transient and are removed after the build, exactly like the GIF pipeline.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
FRAMES = HERE / ".frames" / "screens"
OUTPUT = ROOT / "assets" / "screenshots"

WIDTH = 1440
MAX_HEIGHT = 1500

"""Capture name -> published file name."""
PUBLISHED = {
    "landing": "landing.png",
    "live-city": "optimized-fleet.png",
    "running-clock": "simulation-running.png",
    "road-closure": "road-closures.png",
    "road-reopened": "road-reopened.png",
    "scenario-builder": "scenario-builder.png",
}


def compose(capture: dict) -> Path:
    name = capture["name"]
    image = Image.open(Path(capture["file"])).convert("RGB")

    # The manifest records the header band in CSS pixels; the frame is captured at 2x.
    trim = round(capture.get("headerHeight", 0) * capture.get("scale", 1))
    if trim:
        if trim >= image.height:
            raise SystemExit(f"{name}: the header band ({trim}px) covers the whole frame")
        image = image.crop((0, trim, image.width, image.height))

    if image.width != WIDTH:
        height = round(image.height * WIDTH / image.width)
        image = image.resize((WIDTH, height), Image.Resampling.LANCZOS)

    if image.height > MAX_HEIGHT:
        image = image.crop((0, 0, image.width, MAX_HEIGHT))

    target = OUTPUT / PUBLISHED[name]
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, optimize=True)
    return target


def main() -> None:
    manifest_path = FRAMES / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(
            "no live captures found: run node tools/demos/capture_screenshots.mjs first"
        )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    written = [compose(capture) for capture in manifest["captures"]]
    for path in written:
        size = path.stat().st_size
        print(f"wrote {path.relative_to(ROOT)} ({size // 1024} KiB)")

    shutil.rmtree(HERE / ".frames" / "screens")


if __name__ == "__main__":
    main()

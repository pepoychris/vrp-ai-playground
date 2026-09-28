"""Compose the two portfolio GIFs from real captures of the running product.

The frames are produced by Playwright:

  node tools/demos/capture_execution.mjs   # the deck: deploy, optimise, run, intervene
  node tools/demos/capture_copilot.mjs     # the copilot: activate, ask, answer, report

Both scripts write into ``tools/demos/.frames``, a transient directory that is ignored by
git and deleted once the animations exist. This module adds the restrained timeline/caption
layer the project site uses, cross-fades between chapters and writes the two GIFs into
``assets/demos``.

When the live frames are absent (a machine without the stack running, or without Ollama)
the script still produces both GIFs from the committed screenshots: the execution demo
falls back to the state stills, and the AI demo falls back to a storyboard that is clearly
labelled as a fixture replay instead of pretending to be a live conversation.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
SCREENSHOTS = ROOT / "assets" / "screenshots"
FRAMES = HERE / ".frames"
OUTPUT = ROOT / "assets" / "demos"
OUTPUT.mkdir(parents=True, exist_ok=True)

WIDTH = 960
HEIGHT = 600
BAR_HEIGHT = 74

CYAN = (50, 213, 255)
VIOLET = (165, 111, 255)
GREEN = (51, 224, 170)
AMBER = (255, 146, 74)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/seguisb.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"),
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


FONT_SMALL = font(19)
FONT_MEDIUM = font(26, bold=True)
FONT_LARGE = font(34, bold=True)


def cover(path: Path, width: int = WIDTH, height: int = HEIGHT) -> Image.Image:
    """Scale a capture to fill the canvas, trimming the overflow from the bottom.

    The deck captures are 16:10 and scale exactly. The copilot captures are taller because
    the panel scrolls, so their surplus is dropped from the bottom, which is where the
    least informative pixels sit.
    """
    image = Image.open(path).convert("RGB")
    ratio = width / image.width
    if ratio * image.height < height:
        ratio = height / image.height
    resized = image.resize(
        (round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS
    )
    left = max(0, (resized.width - width) // 2)
    return resized.crop((left, 0, left + width, min(height, resized.height))).resize(
        (width, height), Image.Resampling.LANCZOS
    )


def still(path: Path) -> Image.Image:
    """Fit a committed full-page screenshot into the canvas, centred."""
    image = Image.open(path).convert("RGB")
    ratio = max(WIDTH / image.width, HEIGHT / image.height)
    resized = image.resize(
        (round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS
    )
    left = max(0, (resized.width - WIDTH) // 2)
    top = max(0, (resized.height - HEIGHT) // 2)
    return resized.crop((left, top, left + WIDTH, top + HEIGHT))


def bar(image: Image.Image, title: str, step: int, total: int, accent: tuple[int, int, int]) -> Image.Image:
    """Add the caption band the project site uses under each demo frame."""
    canvas = image.convert("RGBA")
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    top = canvas.height - BAR_HEIGHT
    draw.rectangle((0, top, canvas.width, canvas.height), fill=(2, 7, 15, 240))
    draw.rectangle(
        (0, canvas.height - 5, round(canvas.width * step / total), canvas.height), fill=accent
    )
    draw.text((28, top + 22), title, fill=(242, 247, 255, 255), font=FONT_MEDIUM)
    counter = f"{step:02d} / {total:02d}"
    draw.text(
        (canvas.width - 34 - draw.textlength(counter, font=FONT_SMALL), top + 27),
        counter,
        fill=(*accent, 255),
        font=FONT_SMALL,
    )
    return Image.alpha_composite(canvas, overlay).convert("RGB")


def crossfade(first: Image.Image, second: Image.Image, count: int = 3) -> Iterable[Image.Image]:
    for index in range(1, count + 1):
        yield Image.blend(first, second, index / (count + 1))


@dataclass
class Chapter:
    caption: str
    accent: tuple[int, int, int]
    images: Sequence[Image.Image]
    hold_ms: int = 650
    frame_ms: int = 110
    head_hold: int = 2


FADE_FRAMES = 2
"""Cross-fade frames between chapters; each one is a full-frame delta, so it is budgeted."""

PALETTE_COLORS = 160
"""Adaptive colours per frame. 160 keeps the city gradients clean at a fraction of the bytes."""


def compose(chapters: Sequence[Chapter], path: Path, fade_ms: int = 70) -> None:
    """Render the chapters into a looping GIF, cross-fading between them and back."""
    total = len(chapters)
    rendered: list[Image.Image] = []
    for index, chapter in enumerate(chapters, start=1):
        rendered.extend(
            bar(image, chapter.caption, index, total, chapter.accent) for image in chapter.images
        )

    frames, durations = _timeline(chapters, rendered, fade_ms)
    # The loop closes with a hard cut back to the first chapter: a dissolve here would be a
    # full-frame double exposure of two unrelated screens.

    quantized = [frame.quantize(colors=PALETTE_COLORS, method=Image.MEDIANCUT) for frame in frames]
    quantized[0].save(
        path,
        save_all=True,
        append_images=quantized[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )


def _timeline(
    chapters: Sequence[Chapter], rendered: Sequence[Image.Image], fade_ms: int
) -> tuple[list[Image.Image], list[int]]:
    frames: list[Image.Image] = []
    durations: list[int] = []
    cursor = 0
    for index, chapter in enumerate(chapters):
        block = list(rendered[cursor : cursor + len(chapter.images)])
        cursor += len(chapter.images)
        if index:
            fade = list(crossfade(frames[-1], block[0], FADE_FRAMES))
            frames.extend(fade)
            durations.extend([fade_ms] * len(fade))
        for position, frame in enumerate(block):
            if position == 0:
                repeats = chapter.head_hold
                durations.extend([chapter.hold_ms] * repeats)
            else:
                repeats = 1
                durations.append(chapter.frame_ms)
            frames.extend([frame] * repeats)
    return frames, durations


def execution_chapters() -> list[Chapter]:
    live = FRAMES / "execution"
    shots = sorted(live.glob("*.png")) if live.exists() else []
    if shots:
        by_label = {path.name.split("-", 1)[1].removesuffix(".png"): path for path in shots}
        deck = [
            cover(by_label["landing"]),
            cover(by_label["deck-idle"]),
            cover(by_label["fleet-optimized"]),
            cover(by_label["dashboard-optimized"]),
        ]
        motion = [cover(by_label[f"motion-{index:02d}"]) for index in range(10)]
        closed = [cover(by_label[f"closed-{index:02d}"]) for index in range(4)]
        reopened = [cover(by_label[f"reopened-{index:02d}"]) for index in range(4)]
    else:
        # Fallback: the committed stills, one per state.
        deck = [
            still(SCREENSHOTS / "landing.png"),
            still(SCREENSHOTS / "optimized-fleet.png"),
            still(SCREENSHOTS / "simulation-running.png"),
        ]
        motion, closed, reopened = [], [], []

    chapters = [
        Chapter("RoboRoute Nexus // last-mile control tower", CYAN, [deck[0]]),
        Chapter("Control deck // execution ready", CYAN, [deck[1]]),
        Chapter("Fleet deployed // OR-Tools plan published", CYAN, [deck[2]]),
    ]
    if motion:
        chapters.append(Chapter("Plan published // dashboard + KPIs", CYAN, [deck[3]]))
        chapters.append(
            Chapter("Robots en route // simulation running at x4", GREEN, motion, hold_ms=600, frame_ms=110)
        )
        chapters.append(Chapter("Road closed // planner re-publishes the routes", AMBER, closed, hold_ms=700, frame_ms=150))
        chapters.append(Chapter("Road reopened // revision recovered", GREEN, reopened, hold_ms=1000, frame_ms=150))
    return chapters


def hero_asset() -> Path | None:
    """Derive the landing hero from the 2x city capture.

    The hero needs the product's own render without the deck chrome (the deck wordmark and
    the floating fleet panel sit inside the canvas region), so the top band is trimmed and
    the zoom controls are cropped off the right edge.
    """
    source = FRAMES / "execution" / "hero-canvas.png"
    if not source.exists():
        return None
    image = Image.open(source).convert("RGB")
    width, height = image.size
    left = round(width * 0.02)
    right = round(width * 0.95)
    top = round(height * 0.16)
    bottom = round(height * 0.69)
    target = SCREENSHOTS / "hero-city.png"
    image.crop((left, top, right, bottom)).save(target, optimize=True)
    return target


def ai_chapters() -> list[Chapter]:
    live = FRAMES / "copilot"
    summary = FRAMES / "copilot.json"
    if live.exists() and summary.exists():
        meta = json.loads(summary.read_text(encoding="utf8"))
        seconds = meta.get("answerSeconds")
        by_label = {
            path.name.split("-", 1)[1].removesuffix(".png"): path
            for path in sorted(live.glob("*.png"))
        }
        return [
            Chapter("Local copilot // service and model ready", VIOLET, [cover(by_label["panel-ready"])]),
            Chapter("Qwen core activated // grounded on the live revision", VIOLET, [cover(by_label["core-loaded"])]),
            Chapter("Operator question", CYAN, [cover(by_label["question"])]),
            Chapter("Asking the copilot // validated scenario context", CYAN, [cover(by_label["asking"])]),
            Chapter(
                f"Grounded answer // local Qwen{'' if seconds is None else f', {seconds} s'}",
                CYAN,
                [cover(by_label["answer"])],
                hold_ms=1800,
            ),
            Chapter("Shift report built // deterministic metrics + AI narrative", GREEN, [cover(by_label["report-ready"])]),
            Chapter("Report downloaded // roboroute-shift-report.md", GREEN, [cover(by_label["downloaded"])]),
            Chapter("Report opened // the file's own content", GREEN, [cover(by_label["report-open"])], hold_ms=2200),
        ]
    return fixture_chapters()


def fixture_chapters() -> list[Chapter]:
    """Labelled replay used only when the local model was not reachable during capture."""
    base = still(SCREENSHOTS / "optimized-fleet.png")
    slides = [
        ("AI copilot // fixture replay, local model offline", ["qwen3:4b is fixed by the backend", "No cloud account, no public Ollama port"], VIOLET),
        ("Operator question // fixture replay", ["Why did R-02 carry the longest route?", "Reading the visible scenario revision"], VIOLET),
        ("Grounded answer // fixture replay", ["The detour follows the closed edge", "A proposal still needs human confirmation"], CYAN),
        ("Shift report ready // fixture replay", ["Plan metrics plus the A/B comparison", "Download report (Markdown)"], GREEN),
        ("Report opened // fixture replay", ["The downloaded Markdown file", "Risks, highlights and recommendations"], GREEN),
    ]
    return [
        Chapter(caption, accent, [card(base, caption, body, accent)], hold_ms=1600)
        for caption, body, accent in slides
    ]


def card(image: Image.Image, title: str, body: Sequence[str], accent: tuple[int, int, int]) -> Image.Image:
    canvas = image.convert("RGBA")
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    left, top, right, bottom = 96, 92, canvas.width - 96, canvas.height - 104
    draw.rounded_rectangle((left, top, right, bottom), radius=20, fill=(5, 12, 27, 246), outline=(*accent, 255), width=3)
    draw.text((left + 30, top + 26), "AI COPILOT", fill=(*accent, 255), font=FONT_SMALL)
    draw.text((left + 30, top + 66), title.split(" // ")[0], fill=(245, 248, 255, 255), font=FONT_LARGE)
    y = top + 130
    for line in body:
        draw.text((left + 30, y), line, fill=(169, 190, 218, 255), font=FONT_SMALL)
        y += 36
    return Image.alpha_composite(canvas, layer).convert("RGB")


if __name__ == "__main__":
    hero = hero_asset()
    if hero is not None:
        print(f"{hero.relative_to(ROOT)}: {hero.stat().st_size / 1024:.1f} KiB")
    compose(execution_chapters(), OUTPUT / "roboroute-execution.gif")
    compose(ai_chapters(), OUTPUT / "roboroute-ai-report.gif")
    for output in sorted(OUTPUT.glob("*.gif")):
        with Image.open(output) as gif:
            total_frames = getattr(gif, "n_frames", 1)
            total_ms = 0
            for index in range(total_frames):
                gif.seek(index)
                total_ms += gif.info.get("duration", 0)
        print(
            f"{output.name}: {output.stat().st_size / 1024:.1f} KiB, "
            f"{total_frames} frames, {total_ms / 1000:.1f}s loop, {gif.size[0]}x{gif.size[1]}"
        )

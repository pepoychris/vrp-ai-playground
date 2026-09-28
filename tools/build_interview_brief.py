"""Create the three-page RoboRoute Nexus interview brief."""

from __future__ import annotations

import textwrap
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "roboroute-nexus-interview-brief.pdf"
HERO = ROOT / "assets" / "screenshots" / "hero-city.png"
W, H = A4

BG = colors.HexColor("#050914")
PANEL = colors.HexColor("#0c1628")
PANEL_2 = colors.HexColor("#101d32")
TEXT = colors.HexColor("#f4f8ff")
MUTED = colors.HexColor("#9bb0ca")
CYAN = colors.HexColor("#22d3ee")
BLUE = colors.HexColor("#4facfe")
VIOLET = colors.HexColor("#9b7bff")
GREEN = colors.HexColor("#40dfaa")
CORAL = colors.HexColor("#ff6b5f")


def fit_text(c: Canvas, text: str, x: float, y: float, width: float, size: float = 9.2,
             leading: float = 12, color=TEXT, font="Helvetica") -> float:
    words = text.split()
    lines: list[str] = []
    line = ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if stringWidth(candidate, font, size) <= width:
            line = candidate
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    c.setFillColor(color)
    c.setFont(font, size)
    for item in lines:
        c.drawString(x, y, item)
        y -= leading
    return y


def title(c: Canvas, eyebrow: str, heading: str, subtitle: str, page: int) -> float:
    c.setFillColor(BG)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setStrokeColor(CYAN)
    c.setLineWidth(2)
    c.line(34, H - 34, W - 34, H - 34)
    c.setFillColor(CYAN)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(38, H - 55, eyebrow.upper())
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 25)
    c.drawString(38, H - 88, heading)
    fit_text(c, subtitle, 38, H - 108, W - 76, size=10.5, leading=14, color=MUTED)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8)
    c.drawRightString(W - 38, 25, f"ROBOROUTE NEXUS  |  INTERVIEW BRIEF  |  {page}/3")
    return H - 145


def card(c: Canvas, x: float, y: float, w: float, h: float, heading: str,
         body: str, accent=CYAN, body_size: float = 8.7) -> None:
    c.setFillColor(PANEL)
    c.setStrokeColor(colors.HexColor("#1d3552"))
    c.roundRect(x, y - h, w, h, 10, fill=1, stroke=1)
    c.setFillColor(accent)
    c.rect(x, y - 4, w, 4, fill=1, stroke=0)
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(x + 14, y - 24, heading)
    fit_text(c, body, x + 14, y - 43, w - 28, size=body_size, leading=12.3, color=MUTED)


def bullet_list(c: Canvas, items: list[str], x: float, y: float, width: float,
               accent=CYAN, size: float = 8.8, leading: float = 14) -> float:
    for item in items:
        c.setFillColor(accent)
        c.circle(x + 3, y + 3, 2.2, fill=1, stroke=0)
        y = fit_text(c, item, x + 13, y, width - 13, size=size, leading=leading, color=MUTED)
        y -= 3
    return y


def architecture(c: Canvas, y: float) -> None:
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(38, y, "Architecture in one sentence")
    y -= 24
    nodes = [("Browser", "React + Three.js", CYAN), ("API", "FastAPI + SQLite", BLUE),
             ("Engine", "Graph + OR-Tools", GREEN), ("AI", "Ollama + qwen3:4b", VIOLET)]
    x = 38
    gap = 10
    nw = (W - 76 - gap * 3) / 4
    for index, (head, sub, accent) in enumerate(nodes):
        c.setFillColor(PANEL_2)
        c.setStrokeColor(accent)
        c.roundRect(x, y - 55, nw, 55, 9, fill=1, stroke=1)
        c.setFillColor(accent)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(x + 10, y - 20, head)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7.6)
        c.drawString(x + 10, y - 38, sub)
        if index < 3:
            c.setStrokeColor(MUTED)
            c.setLineWidth(1)
            c.line(x + nw + 2, y - 28, x + nw + gap - 3, y - 28)
        x += nw + gap
    fit_text(c, "The browser sends same-origin commands. The API owns state and revisions, the solver owns route quality, and the local model explains validated snapshots without mutating them.", 38, y - 78, W - 76, size=8.8, leading=12, color=MUTED)


def page_one(c: Canvas) -> None:
    y = title(c, "01 / The story", "RoboRoute Nexus", "A 3D last-mile control tower that turns a delivery scenario into an operable route plan, then explains every revision with local AI.", 1)
    if HERO.exists():
        image = ImageReader(str(HERO))
        iw, ih = image.getSize()
        box_w, box_h = 245, 148
        scale = min(box_w / iw, box_h / ih)
        c.drawImage(image, W - 38 - iw * scale, y - ih * scale + 2, iw * scale, ih * scale, preserveAspectRatio=True, mask="auto")
    card(c, 38, y, 280, 148, "30-second pitch", "RoboRoute Nexus is an offline-first logistics sandbox. Operators deploy robots, generate orders, run a bounded vehicle-routing optimisation, watch the plan move through a low-poly city, close a road, and ask a local copilot why the plan changed.", CYAN)
    card(c, 38, y - 164, 250, 126, "The problem", "Last-mile operations are difficult to reason about when routes, capacity, closures and delays change together. The project makes the decision loop visible and repeatable instead of hiding it behind a black-box map.", CORAL)
    card(c, 307, y - 164, 250, 126, "The proof", "The same local road graph powers the Three.js scene and the solver. A scenario revision is the shared unit between commands, KPIs, simulation events, copilot answers and shift reports.", GREEN)
    architecture(c, y - 330)
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(38, 225, "Operator loop")
    bullet_list(c, ["Configure: deploy 1-6 vehicles and generate 6-24 orders.", "Optimise: solve capacity, time-window, duration and cost constraints with OR-Tools.", "Operate: start, pause, speed up, relocate a robot, close a road and re-plan.", "Explain: ask Qwen about the current revision and export a grounded report."], 38, 203, W - 76, accent=CYAN)
    c.setFillColor(PANEL_2)
    c.roundRect(38, 54, W - 76, 78, 10, fill=1, stroke=0)
    c.setFillColor(CYAN)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(52, 111, "KEY SIGNALS")
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 15)
    c.drawString(52, 85, "Local-first")
    c.drawString(185, 85, "Revision-safe")
    c.drawString(326, 85, "Human-gated")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8)
    c.drawString(52, 68, "No paid AI API")
    c.drawString(185, 68, "Atomic snapshots")
    c.drawString(326, 68, "AI never acts alone")


def page_two(c: Canvas) -> None:
    y = title(c, "02 / Engineering choices", "Decisions worth explaining", "The strongest interview answers are about boundaries: which component owns which truth, and why the system stays understandable under change.", 2)
    card(c, 38, y, 250, 128, "Custom graph, not a map API", "The fictional city is backed by a local graph with stable node and edge ids. Three.js renders the same dataset the router uses, so a barrier blocks a real edge rather than a visual region.", CYAN)
    card(c, 307, y, 250, 128, "OR-Tools is the optimiser", "The solver handles assignment, capacity, time windows and route duration. Economic cost is calculated separately, so internal objective units are never mislabeled as euros.", GREEN)
    y -= 146
    card(c, 38, y, 250, 128, "Revisions prevent stale UI", "Every mutation carries a command id and scenario revision. The frontend keeps the highest accepted revision and drops late responses instead of showing an older plan over a newer one.", BLUE)
    card(c, 307, y, 250, 128, "Docker keeps boundaries explicit", "Frontend and API publish host ports. Ollama stays on the internal backend network, with a persistent model volume and cloud features disabled.", VIOLET)
    y -= 146
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(38, y, "AI: interpreter, not optimiser")
    y -= 19
    bullet_list(c, ["The backend fixes qwen3:4b and the inference options; the browser cannot select arbitrary models.", "The model receives a validated scenario snapshot and a question, not an open-ended database connection.", "Responses are schema-validated, grounded in JSON field paths and tagged with the revision used.", "Proposals require human confirmation, while deterministic snapshot metrics anchor the report narrative."], 38, y, W - 76, accent=VIOLET, size=8.2, leading=11)
    y -= 75
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(38, y, "Security and reliability talking points")
    y -= 19
    card(c, 38, y, 250, 100, "Trust boundary", "Browser -> API -> Ollama. The browser never sees Ollama and no model name is accepted from user input.", CORAL, 8.2)
    card(c, 307, y, 250, 100, "Failure behaviour", "If Ollama is unavailable, the control tower still runs. The copilot reports a retryable error; routing and simulation remain useful.", CYAN, 8.2)
    y -= 120
    card(c, 38, y, 250, 90, "Evidence", "Playwright covers the landing, deck, live clock, road closures, responsive layout and the published docs page.", GREEN, 8.2)
    card(c, 307, y, 250, 90, "Deliberate limits", "No auth, GPS, traffic, weather, mobile app, RAG, public Ollama or production-scale fleet claims.", BLUE, 8.2)
    c.setFillColor(PANEL_2)
    c.roundRect(38, 34, W - 76, 40, 8, fill=1, stroke=0)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Oblique", 8.3)
    c.drawString(52, 58, "Interview framing: every visual action is backed by a real state transition and a testable contract.")


def page_three(c: Canvas) -> None:
    y = title(c, "03 / Interview mode", "How to present it", "Lead with the decision loop, then zoom into one tradeoff and one proof point. Keep the demo narrative shorter than the code tour.", 3)
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(38, y, "A two-minute walkthrough")
    y -= 21
    steps = [("01", "Open", "The city starts idle. This proves startup has no hidden scenario generation or model download."), ("02", "Plan", "Deploy two robots, generate orders and run the bounded solver. Read distance, duration, cost and unassigned orders."), ("03", "Operate", "Start the clock at x4. Pause it. Close a road and show the coral edge, revision bump and detour."), ("04", "Explain", "Ask why the route changed. Show the grounded answer, human proposal gate and shift report download." )]
    for number, head, body in steps:
        c.setFillColor(CYAN if number in {"01", "03"} else VIOLET)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(42, y, number)
        c.setFillColor(TEXT)
        c.setFont("Helvetica-Bold", 10)
        c.drawString(76, y, head)
        y = fit_text(c, body, 126, y, W - 164, size=8.7, leading=12, color=MUTED) - 8
    y -= 7
    card(c, 38, y, W - 76, 83, "Elevator answer", "I built an offline-first 3D last-mile control tower. The API owns a revisioned scenario, OR-Tools owns route optimisation, Three.js renders the same graph, and a local Qwen copilot explains validated snapshots without changing them autonomously. The result is a demo where every visual intervention has an operational consequence.", CYAN, 8.8)
    y -= 101
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(38, y, "Questions you should be ready for")
    y -= 21
    qa = [
        ("Why not use Google Maps?", "The fictional graph makes the demo offline, deterministic and visually coherent. It also lets a barrier block the exact edge used by the solver."),
        ("Why local AI?", "Privacy, reproducibility and no vendor dependency. The model explains computed facts; it is not trusted with optimisation or direct mutations."),
        ("How do you avoid race conditions?", "Command ids, scenario revisions, atomic snapshots and a frontend guard that rejects stale results."),
        ("What would you build next?", "Authentication, persisted run history, richer fleet constraints and production observability - after the current contract boundary is stable."),
    ]
    for question, answer in qa:
        c.setFillColor(TEXT)
        c.setFont("Helvetica-Bold", 8.8)
        c.drawString(38, y, question)
        y = fit_text(c, answer, 190, y, W - 228, size=8.3, leading=11, color=MUTED) - 9
    c.setFillColor(PANEL_2)
    c.roundRect(38, 68, W - 76, 91, 10, fill=1, stroke=0)
    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(52, 137, "RUN IT")
    c.setFillColor(TEXT)
    c.setFont("Courier", 8.5)
    c.drawString(52, 117, "docker compose up --build")
    c.setFont("Helvetica", 8.3)
    c.setFillColor(MUTED)
    c.drawString(52, 96, "Open http://localhost:8080  |  API health: http://localhost:8000/health")
    c.drawString(52, 80, "Install Qwen only when the operator presses Install Qwen Core.")


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    c = Canvas(str(OUT), pagesize=A4, pageCompression=1)
    c.setTitle("RoboRoute Nexus - Interview Brief")
    c.setAuthor("RoboRoute Nexus")
    page_one(c)
    c.showPage()
    page_two(c)
    c.showPage()
    page_three(c)
    c.save()
    print(OUT)


if __name__ == "__main__":
    main()

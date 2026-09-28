---
layout: page
title: "Agent orchestration"
description: "How implementation, review and correction agents work in this repository."
---

# Agent orchestration

This project uses a phase-based workflow to keep implementation fast and focused.

## Project language

English is mandatory for all project workflow and delivery artifacts: phase packets,
agent reports, branch names, commit messages, GitHub issues, pull requests, reviews,
comments, checklists, and status updates. New workflow text must not use Spanish
labels or phase names, and existing workflow wording should be translated whenever it
is edited.

## Project-completion interview PDF trigger

When the user says that the PDF is required to finish or close the project (including
wording such as “I need the PDF to consider the project finished”), treat that as an
explicit completion deliverable. Automatically generate or update the stable
three-page interview brief at `output/pdf/roboroute-nexus-interview-brief.pdf`.
Render and visually inspect every page, verify the page count and output path, and
include the PDF in the completion gate before reporting the project complete. The
project must not be marked complete while this artifact is missing or unverified.

- One `phase_implementer` handles one cohesive packet of related MVP work.
- MVP phases are strictly sequential: implementation, review/correction, focused
  verification, and remote delivery for one numbered phase must finish before the
  next numbered phase starts. Never combine two MVP phases in one packet, even when
  they share files or runtime primitives.
- The packet contains the exact scope, files, acceptance criteria, non-goals, and
  focused verification commands; unrelated project content is omitted.
- Any user-facing UI, visual, layout, interaction, or `frontend/` change is a
  frontend task and must include a `REFERENCE IMAGES` field in the packet. The
  field lists absolute image paths or URLs and the thematic cues to extract. When a
  net-new visual direction has no references, implementation waits until the
  orchestrator obtains them.
- Frontend implementation agents inspect all supplied references, use them as
  thematic inspiration rather than copying protected assets, and report the
  selected cues plus intentional deviations.
- Playwright is mandatory for frontend browser verification. The phase must add or
  update a Playwright scenario for the changed flow, run it against the real app,
  exercise the primary interaction, fail on unexpected page/console errors, and
  capture desktop and relevant responsive screenshots. The screenshots are reviewed
  as part of the phase gate.
- A frontend phase cannot pass focused verification or remote delivery without a
  successful Playwright run and visual screenshot review. Unit tests, type checks,
  and build checks remain required as separate gates. If no Playwright command or
  configuration exists yet, the phase adds the smallest pinned setup using the
  approved `@playwright/test` version before changing the UI.
- A single `phase_reviewer` runs only after the whole phase is implemented. It reviews
  the complete diff once and does not edit files.
- Any findings are grouped into one correction request to the implementing agent,
  followed by focused verification. Unchanged work is not reviewed again.
- `.codex/config.toml` keeps subagents serial with one active thread at a time.
- The primary orchestrator uses `gpt-5.6-luna` with high reasoning effort.
- Implementation and review agents use `deepseek/deepseek-v4.1-flash`; they do not
  inherit the orchestrator's model.
- CodeGraph is initialized for structural navigation and impact checks; its local
  database is ignored and can be rebuilt with `codegraph init -i` on a new machine.
- The remote repository uses `develop` as the protected integration branch and
  GitHub default branch. The orchestrator creates it from the bootstrap base before
  publishing the first phase; `main` is not a phase integration target.
- Once a phase implementer is launched, the orchestrator must leave it running until
  it returns an explicit terminal result (completed, blocked, or errored). Timeouts,
  slow progress, or intermediate inactivity are not reasons to interrupt the agent;
  the orchestrator should wait, or send a non-destructive status nudge if needed.
  Cleanup/interrupt is allowed only after that terminal result has been received.
- The repository owner authorizes the orchestrator to publish completed phase
  branches, create pull requests, wait for required checks/reviews, and merge an
  approved pull request into the repository's protected integration branch after the
  merge gate passes. This authorization applies to each subsequent completed phase;
  it does not authorize unrelated changes, force-pushes, or merges that have not
  passed the gate.

This workflow is deliberately conservative about spawning agents: larger context
packets replace one-agent-per-subtask fan-out, reducing duplicate repository
discovery, repeated reviews, and unnecessary token usage.

## Branch and merge gate

The primary orchestrator owns integration. Before the first phase delivery it
creates `develop` from the repository's bootstrap base and configures `develop` as
the GitHub default/protected integration branch. Each phase is then worked on a
short-lived branch created from `develop`, using the `codex/` prefix and a
English phase-specific name (for example, `codex/phase-0-contracts`). The branch is created
before the phase commit; local tooling artifacts such as `.codegraph/`, `.codex/`
and `.cursor/` remain untracked and are not included in phase commits.

## Issue and pull-request gate

At the start of each phase delivery, the orchestrator creates the GitHub issues that
cover the cohesive phase scope and its acceptance criteria. The phase branch and
commit stay local until the phase verification gate is green. The orchestrator then
pushes the branch, opens one PR into `develop`, and includes a closing reference for
each issue in the PR body (for example, `Closes #123`). Before merging it verifies
that the intended issues appear as linked/closing issues on the PR and that required
checks and reviews have passed.

The orchestrator may commit and merge only after all of the following are true:

1. The implementation packet is complete and the phase reviewer has returned a pass,
   or all grouped findings have been corrected and re-verified.
2. The orchestrator has run the focused final verification and confirmed every
   acceptance criterion, including the relevant build and test commands.
3. The commit contains only the phase files and any explicitly requested
   workflow/docs changes; no credentials or generated local state are included.

Once the gate is green, the orchestrator commits the phase on its branch with a
Conventional Commit message, pushes that branch to the configured remote, and creates
the pull request targeting `develop`. The orchestrator owns the PR lifecycle: it
waits for required CI/review checks, addresses actionable feedback through the normal
correction gate, and merges the approved PR using **squash merge only**. It then
deletes the phase branch when allowed and verifies the local checkout, remote
branch/PR state, linked issues, and resulting squash commit on `develop`. If remote
credentials, CI, branch protection, issue association, or repository permissions are
unavailable, the orchestrator must report that blocker instead of silently treating a
local merge or unassociated PR as complete.

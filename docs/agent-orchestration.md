---
layout: page
title: "Agent orchestration"
description: "How implementation, review and correction agents work in this repository."
---

# Agent orchestration

This project uses a phase-based workflow to keep implementation fast and focused.

- One `phase_implementer` handles one cohesive packet of related MVP work.
- The packet contains the exact scope, files, acceptance criteria, non-goals, and
  focused verification commands; unrelated project content is omitted.
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
phase-specific name (for example, `codex/fase-0-contratos`). The branch is created
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

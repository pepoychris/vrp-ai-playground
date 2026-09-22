# RoboRoute Nexus agent workflow

These instructions govern implementation work in this repository. The MVP in
`MVP_ROBOROUTE_ULTIMA_MILLA.md` is the source of truth for product scope,
technical decisions, phase boundaries, and acceptance criteria.

## Project language

English is the project-wide working language for engineering and delivery. Context
packets, agent reports, branch names, commit messages, issue titles/bodies, pull
requests, reviews, comments, checklists, and status updates must be written in
English. Do not introduce Spanish workflow labels or phase names; translate existing
workflow wording when it is touched.

## Orchestration policy

Use `gpt-5.6-luna` with `high` reasoning for the primary orchestrator. Implementation,
review, and correction subagents must use `deepseek/deepseek-v4.1-flash`. The project
config intentionally limits the session to one active subagent, so work is serial and
review cannot overlap implementation.

The model selection is an execution requirement, not a default or preference. Every
subagent dispatch must pass the explicit model override
`deepseek/deepseek-v4.1-flash` (and the orchestrator must remain
`gpt-5.6-luna`/`high`). Never rely on inherited session defaults. A dispatch without
these explicit values is invalid and must be corrected before work continues.

Treat each MVP phase as one cohesive packet. Group related work that touches the
same flow or files into one larger implementation packet; do not launch one agent
per file, endpoint, test, or correction. Split a phase only when the work is
genuinely independent and cannot safely share context, and keep the number of
agents minimal.

The remote repository uses `develop` as the protected integration branch and GitHub
default branch. `main` is only the bootstrap branch that may exist before this
workflow is configured. Before the first phase is published, the orchestrator must
create `develop` from the current repository base and configure it as the default
branch; afterwards, phase work must never be merged directly into `main`.

Before launching an implementation agent, the parent must provide a compact context
packet containing only:

- objective and in-scope MVP phase/tasks;
- exact files/symbols to inspect or change;
- relevant existing behavior and decisions;
- acceptance criteria and non-goals;
- focused commands/tests to run;
- constraints, assumptions, and known risks.

The packet must not paste the whole MVP or unrelated repository files. The
implementation agent starts from that packet, reads only targeted context,
implements the complete packet, adds required tests/docs, and reports results. It
must not spawn more agents, perform a second self-review, or expand scope.

## Review and correction gate

1. Launch the single phase implementer and wait for it to finish.
2. Inspect the implementer's final analysis before deciding whether another agent is
   needed. If it explicitly states that the implementation is correct, all required
   tests pass, and there are no known issues or blockers, trust that report as the
   phase review and do not launch a new reviewer.
3. If any of those statements is missing, ambiguous, or negative, launch exactly one
   holistic phase reviewer. The reviewer receives the same packet plus the complete
   phase diff and is read-only.
4. Do not launch independent reviews per issue, file, or finding.
5. If the reviewer reports defects, send one grouped correction request to the
   implementation agent(s) that changed the affected work. Include the finding,
   location, impact, and acceptance condition directly; do not make them rediscover
   the repository. The implementer applies all applicable fixes in one pass and runs
   focused verification.
6. The parent performs the final focused verification. Do not re-review unchanged
   work or start another review cycle unless the correction materially changes the
   phase scope or the user explicitly requests it.

Keep status messages short and avoid token-heavy progress narration. Prefer one
consolidated result per phase over repeated summaries. Never mark a phase complete
when an acceptance criterion is unverified; report the exact blocker instead.

## Remote delivery and issue gate

Every completed phase must be delivered to the remote repository before it is
reported as complete:

1. Create or verify the GitHub issues that represent the phase scope and acceptance
   criteria. Keep them grouped by cohesive behavior, not one issue per file or test.
2. Create a short-lived branch from `develop` using the `codex/` prefix and a
   English phase-specific name.
3. Commit only the phase changes with a Conventional Commit message and push the
   branch to the configured `origin` remote.
4. Open one pull request from that branch into `develop`, listing the phase issues
   and using closing references such as `Closes #123` so GitHub associates them with
   the PR and closes them on merge.
5. Verify that every intended issue is associated with the PR before merging, then
   wait for required checks and reviews.
6. Merge the approved PR with **squash merge only**, delete the phase branch when
   allowed, and verify that the resulting squash commit is on `develop`.

If issue creation, branch protection, remote credentials, PR association, checks, or
squash merge is unavailable, the orchestrator must report the exact blocker and must
not treat a local commit or unmerged PR as phase completion.

## Context lookup

Use CodeGraph first for structural questions (`codegraph_context`, `codegraph_search`,
`codegraph_callers`, `codegraph_callees`, and `codegraph_impact`). The project is
initialized with `.codegraph/config.json`; its database is machine-local and ignored.
If CodeGraph reports that the project is not initialized, ask whether to run
`codegraph init -i` before relying on it. Use `rg` or targeted file reads only for
literal text and for the narrow context named in the packet.

## Context packet template

```text
PHASE: <short name>
OBJECTIVE: <one sentence>
IN SCOPE: <grouped behavior and contracts>
FILES/SYMBOLS: <exact paths and entry points>
EXISTING CONTEXT: <only facts needed to edit safely>
ACCEPTANCE: <observable checks>
NON-GOALS: <explicit exclusions>
VERIFY: <focused commands/tests>
CONSTRAINTS/RISKS: <compatibility, security, or assumptions>
OUTPUT: changed files, verification results, assumptions, deviations, remaining issues
```

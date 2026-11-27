# Changelog

All notable changes to `dsh-mentor` are documented in this file.

## [1.0.0] - 2026-11-27

### Added
- **Apple-style Interactive Mind-Map UI (`lib/client.js`)**:
  - Replaced stacked vertical text/accordion clutter with a default **Apple Freeform / MindNode** organic Bézier mind-map canvas (`Root → Stage Branches → Level-2 Criteria/Diff/Precheck Leaves`).
  - Added **Auto-Fit Zoom** (`ResizeObserver`), click-to-focus upstream/downstream dependency isolation, inline **Node Inspector** drawer (with criteria status, diff totals, precheck summary, and 1-click rollback preview), and macOS segmented **`导图 | 列表`** toggle.
- **Verification & Security Guardrails**:
  - **Stuck-Loop Detector**: Detects repeated errors, A↔B oscillation, and search thrashing with escalate-from-steer-to-halt semantics.
  - **Pre-Plan Clarification / Abstention Gate** (`/mentor clarify`): Flags contradictory constraints and unscoped destructive goals before wasted execution.
  - **External MCP Tool Security Monitor**: Detects tool schema Rug-Pull drift and description prompt-injection patterns.
  - **Diff-Scoped Mutation Testing** (`/mentor mutate`) & **Fail-to-Pass (`f2p`)** checks to catch vacuous tests.
  - **Delivery Artifacts**: One-click PR Verification Receipt (with explicit `UNVERIFIED` disclosure), SHA-256 Task Passport, ATIF v1.6 trajectory export, and `/mentor health` score.
- **v0.5 Foundations**:
  - Risk-based dynamic rigor tiers (`express / standard / strict`), real Git/snapshot workspace diff audit & test-tamper scanner, stage checkpoints with two-step conflict-aware rollback, and ACE-style scoped project lessons with helpful/harmful feedback decay.

### Fixed
- **Windows `pwsh` precheck compatibility (`src/runtime/prechecks.js`)**: Automatically falls back leading `pwsh` / `pwsh.exe` precheck commands to Windows PowerShell 5.1 (`powershell`) when PowerShell 7 is absent from `PATH`, attaching an explicit `note` rather than silently rewriting.
- **`mentor_plan_amend` silent no-op risk (`src/tools/handlers.js`)**: Echoes `changedFields` and `noOp` on every amendment, and returns an explicit `warning` when neither `stages` nor `criteria` actually changed.

## [0.4.0] - 2026-11-25
- Added optional Git Worktree physical isolation for parallel write workers, cross-session handoff/takeover, reversible archive with 10-second undo banner, synchronous pre-execution reviewer tool guard, and Calm UI `v9-pro` hot-swap shell.

## [0.1.0] - 2026-11-02
- Initial clean-room implementation of DAG task planning, independent read-only review loop, finding remediation, and DSH composer panel with zero external runtime dependencies.

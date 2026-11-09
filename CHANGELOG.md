# Changelog

User-visible changes are recorded here. Iteris uses [Semantic Versioning](https://semver.org/); configuration format versions are independent of the application version.

## [Unreleased]

### Fixed

- Trusted review context larger than `verification.maxContextCharacters` is detected before any instance starts. Previously every attempt implemented the task, failed when preparing the review, and was retried indefinitely. The task now waits with the configured and actual sizes, and continues once the limit is raised.
- A task whose worktree directory was deleted (for example by removing `.iteris/`) is checked out again from its branch. Previously every attempt failed with `ENOENT` while preparing the workspace.

## [1.2.0] — 2026-11-08

### Changed

- A failed attempt no longer abandons its task or waits for input. Iteris journals the cause, stops the instance, keeps the branch, commits, plan and evidence, reschedules the task with backoff, and starts a fresh instance whose prompt includes the journal. The **Retry/Skip** dialog is removed; failed tasks show **retrying**.
- Blocked reviews, failed CI repairs, workspace and host errors, and exhausted setup budgets are retried instead of becoming permanently blocked. When review blocked a commit, a repair instance fixes it before review runs again.
- The implementation prompt no longer tells agents to commit failing work and move on. Checks that genuinely cannot run locally must be reported, not skipped.
- Tasks left blocked by earlier versions rejoin the attempt loop automatically.

### Added

- Per-task attempt journal in `run.json`, rendered to `.iteris/tasks/<key>/attempts.md` and summarized in `iteris status`.
- `recovery.idleTimeout` (default 1800 seconds) kills instances that stop producing output.
- `recovery.maxTaskAttempts` (default `0`, unlimited) optionally stops a task after repeated failures; `iteris resume` grants a fresh budget.
- Uncommitted partial work from a crashed instance is committed as a checkpoint so the next attempt starts from it.
- `npm run test:soak`, run in CI: a 20-ticket chaotic backlog must drain to zero without human input.

### Fixed

- Exhausting the task allowance after every check passed no longer blocks a verified task; a fresh readiness check completes it.
- An unexpected host error in one task no longer stops the whole queue.
- The test suite no longer depends on the CI runner's `CI` variable or Git default branch.

### Compatibility

- Node.js 22 or newer is required, as before. Configuration remains version 3 and needs no migration; the new `recovery` keys have defaults.
- Behavior change: failed tasks are retried until they finish instead of stopping. To cap retries, set `recovery.maxTaskAttempts`. Set `recovery.idleTimeout` to `0` to disable the stall watchdog.
- Existing task records load unchanged. Tasks that 1.1.0 left blocked are picked up again on the next queue or `iteris resume`.
- Before running an earlier version again, remove `recovery.maxTaskAttempts` and `recovery.idleTimeout` from `.iteris.json`; 1.2.0 may write them when it saves settings. See [release notes](docs/releases/v1.2.0.md).

## [1.1.0] — 2026-10-13

This release was prepared but never tagged, so the tagged installer cannot select it. Version 1.2.0 includes all of its changes.

### Added

- Parallel task execution in dedicated Git worktrees with a configurable limit of 1–8 tasks (default: 3).
- A saved workspace default in setup, `iteris workspace`, and the live `/workspace` command. Existing projects keep local, serial execution.
- A live Instances view with task status, harness, branch, checkout, elapsed time, PR, and focused output. Monitor a queue from another terminal with `iteris instances`.
- Best-effort copying of Git-ignored files matched by `.worktreeinclude` for both Codex and Claude Code, including environment files and nested directories.
- Persistent task workspace identity, so retries and resumed queues reuse the original checkout.
- `iteris --version` and `-V`, tagged installation, release notes, and automated draft releases with package checksums.

### Fixed

- Keep task state and logs in the project root while agents execute in their own checkouts.
- Isolate project-local harness environments and protect parallel tasks from one another's state reconciliation.
- Deduplicate repeated source tasks before dispatch so two agents cannot write to the same worktree.
- Preserve destination files during worktree setup; skip missing files, symlinks, and protected Git/Iteris state.
- Correct installer URLs to use the actual default branch and remove outdated automatic harness-install claims.

### Compatibility

- Node.js 22 or newer is required, as before. Configuration remains version 3.
- Worktrees are opt-in and retained after completion. Started tasks keep their checkout when defaults change.
- Dependency installation and shared service ports remain project responsibilities. See [release notes](docs/releases/v1.1.0.md).

## 1.0.0 — Previous untagged baseline

The package identified itself as 1.0.0 before formal tagged releases. This entry records that baseline without assigning a historical release date or retroactive tag.

- Claude Code and Codex task execution, independent review, and pull-request publication.
- GitHub Issues/Projects, Trello, custom REST imports, and configured command adapters.
- Configurable completion evidence, recovery, and persisted task continuation.

[1.2.0]: https://github.com/Oscar-Codes-Life/Iteris/releases/tag/v1.2.0
[1.1.0]: https://github.com/Oscar-Codes-Life/Iteris/tree/10d99983109b3b54e89859ea56645dab7d006451

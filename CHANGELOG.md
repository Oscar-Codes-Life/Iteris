# Changelog

User-visible changes are recorded here. Iteris uses [Semantic Versioning](https://semver.org/); configuration format versions are independent of the application version.

## [Unreleased]

### Changed

- **Evidence no longer goes into the repository.** Instances were told to "record" how they verified their work without being told where, and reviewers only see the committed tree, so logs, transcripts, validation notes and plan documents were committed and filled pull requests. Each task now has an ignored folder, `.iteris/evidence/<task>/`, which the host never commits, shows to reviewers and archives with the task. A reviewer treats such a file added by the diff as a blocking finding.
- **Evidence Iteris cannot obtain itself no longer holds a task by default.** A device session, a hosted service or an attachment the ticket did not supply is listed in the review and the PR as *needs manual verification*, and the task completes once local checks, independent review and required CI pass. Set `workflow.externalEvidence` to `required` to keep the earlier behavior of waiting for submitted evidence. Stages declared in `verification.stages` block in either mode.
- Each attempt merges the current base into the task branch before work continues, with an instance resolving conflicts. A base that moves afterwards invalidates a published, reviewed commit only when it no longer merges cleanly or the repository requires an up-to-date branch.
- Review phases are allowed a quarter of `timeout` instead of a fixed 15 minutes, unless `review.timeout` is set.
- On macOS the queue holds a power assertion (`caffeinate`) while it runs, so an idle Mac does not sleep and silently stop it.

### Added

- `iteris describe [key] [--dry-run]` rewrites the description, review and completion parts of already published pull requests from the final diff and the saved run. A description that already covers the published commit is kept, so a rerun only refreshes the other parts and needs no harness call; `--rewrite` forces a new one. `iteris describe --all` also heals pull requests from earlier queues, open, merged or closed, that still carry a placeholder description: it writes the description from the diff GitHub holds, keeps text a person added above it and folds the long lists.

### Fixed

- **Pull requests were unreadable.** A PR opened as a draft before its review passed kept a placeholder forever: the ticket title as summary, a list of every changed file and a snapshot of the requirement checklist with every box unticked, which stayed after the task was verified. The description is now written from the final diff once the review passes, and nothing stale is left behind.
- The PR's completion section was the internal status file: requirement identifiers, the source URL and one evidence line per requirement per attempt, enough to hit GitHub's size limit and truncate the review to nothing. It now states where the task stands, what is not yet verified and what a person must verify by hand, with the ticket requirements folded.
- The review in the PR folds its per-requirement, per-command and fixed-finding lists, keeping the verdict, open findings and unverified areas visible.
- Open findings in the PR show as one line each with their evidence folded, and items to verify by hand show the requirement without the reviewer's paragraph of evidence.
- Everything Iteris publishes shortens home-directory paths to `~`; reviews quoted commands and task files with the account name of the machine that ran them.
- Bare labels (`Acceptance criteria:`) and the task-file lines Iteris appends to custom tasks were treated as ticket requirements, which put a local path in the PR and produced manual-verification items about nothing.
- Every `git` command in an isolated check failed with exit 128 because the sandbox denied `/dev/null`. Planned checks such as `git diff --check` could never pass, so no review could.
- Reviewers reported the host's own gates (publication, required CI, local checks) as unverified before a pull request existed, and each such entry made the review incomplete. The host now ignores reviewer opinions of requirements it decides itself.
- Planned checks for host-owned stages (`gh pr view`, `gh pr checks`), for a `REVIEW.md` the base does not have, or needing a tool that is not installed (`adb`, `maestro`) were run as required gates and failed every review. Instances also created `REVIEW.md` to satisfy them.
- Task branches were cut from a stale local base and never updated. Their pull requests conflicted with the target, GitHub ran no pull-request checks on them, and required CI could never report.
- A parallel task fetching the base changed the review snapshot of the other tasks mid-review.
- A pull request body over GitHub's 65,536-character limit failed publication; the generated sections are now shortened in place.
- Required-check discovery failed with `Branch not protected` on a repository whose base branch is covered only by rulesets, so a task with passing checks, review and CI could never complete. A missing classic protection is now read as no classic rules, and the rulesets are used.
- A planner-suggested command that starts a dev server, drives a device or calls the code host (`npm start`, `expo start`, `adb`, `maestro`, `gh`) is recorded as absent evidence and not run. The independent verifier can also attribute another failed suggested command to the host (occupied port, refused simulator, no network); it then stops gating and is shown as such in the review. Configured `qualityChecks` and `verification.checks` always run and always gate.
- A medium or low finding outside the acceptance category made reviewers mark requirements missing, which blocked the review while the repair instance received none of the finding's detail. Reviewers now keep such requirements covered and report the finding; when a requirement is missing, the repair receives every confirmed finding on that commit, and the between-attempt repair is pointed at the saved review and findings.
- Non-blocking findings raised on an earlier commit stayed listed as confirmed after later commits no longer showed them.

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

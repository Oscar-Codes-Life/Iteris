# Iteris

![Iteris Cover](assets/Iteris-cover.png)

Iteris pulls tickets from **GitHub Issues, GitHub Projects, or Trello**, implements them with **Claude Code or Codex**, reviews the changes, and opens pull requests. It runs locally with a live terminal UI.

> **Experimental autonomous agent.** Implementation and repair use full-access Codex execution by default; Claude retains its configured permission flags (the default skips permission prompts). These writing agents can run commands and change files beyond the repository. Review investigators use restricted permissions on disposable committed snapshots. Configured quality-check commands execute locally with your user permissions. Use a controlled environment appropriate for autonomous execution.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Oscar-Codes-Life/Iteris/main/install.sh | bash
```

Requires macOS/Linux, Node.js 22+, Git, and [GitHub CLI](https://cli.github.com/). The installer clones Iteris into `~/.iteris`, builds it, and links `iteris` globally. Rerun the installer to update Iteris.

Choose either harness:

- **Codex:** Iteris installs it automatically if missing, checks for updates, waits for completion, and opens login when needed. Existing installations use `codex update` where available; older installations use their detected npm, Homebrew, or standalone installer. Unknown installations require a manual update or explicit continuation after capability checks.
- **Claude Code:** install it separately and authenticate. Iteris can launch `claude auth login` when required. It does not install or update Claude automatically.

GitHub credentials are resolved from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`. If missing, setup launches GitHub CLI browser login. Credentials stay out of `.iteris.json`; GitHub CLI manages their storage and may fall back to a plaintext user file if its credential store is unavailable. See [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login).

GitHub Projects access and repository permissions must allow reading project items/issues, writing repository content, and opening pull requests. Trello additionally requires `TRELLO_API_KEY` and `TRELLO_TOKEN`; its existing credential wizard remains available. GitHub authentication is required with either source because Iteris ships PRs to GitHub.

## Setup and usage

```bash
cd your-repository
iteris
```

First run follows this order:

1. Choose **Claude Code** or **Codex**; wait for prerequisite checks and login.
2. Choose a model.
3. Choose a supported effort level. Models without configurable effort show **Not supported**.
4. Authenticate with GitHub, if needed.
5. Choose GitHub or Trello, then the project or board/list as needed. If no GitHub Projects are visible, Iteris shows open repository issues instead.
6. Select tickets and watch the active ticket, phase, harness, model, effort, and logs.

Subsequent launches reuse project settings and proceed to ticket selection after prerequisite checks. `iteris setup` repeats harness/model/effort, authentication, and source setup, then exits without running tickets. Project/board and ticket selection happen when you next run `iteris`.

If a Codex update fails, the UI offers retry or another harness. Explicit continuation is available only when the installed CLI supports the required execution capabilities; model discovery and authentication must still succeed. No updates run during an active ticket.

## Change harness, model, or effort

| Terminal command | Command inside the live UI |
| --- | --- |
| `iteris harness [claude\|codex]` | `/harness [claude\|codex]` |
| `iteris model [model-id]` | `/model [model-id]` |
| `iteris effort [level]` | `/effort [level]` |

Omit the argument to open a picker. Type `/` in the live UI to enter a command; press Enter to submit or Escape to cancel. Terminal commands save settings and exit without running tickets.

Each harness remembers its own model and effort. Model changes retain compatible effort settings; otherwise they use the selected model's advertised default. Codex models and effort identifiers come from the installed CLI's paginated `model/list` catalog, not a fixed OpenAI API list. Claude's model capability catalog follows [Anthropic's model configuration documentation](https://code.claude.com/docs/en/model-config).

To use [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) with Codex, run `iteris harness codex` and then `iteris model gpt-6-sol`. Iteris selects the model's advertised default effort unless your current effort is also supported; use `iteris effort medium` to set medium explicitly. New Codex models appear as they become available in the installed CLI's catalog for your account.

Changes are saved immediately and apply to the **next ticket**. An active ticket uses the same selection through planning, implementation, review, PR description, summary, and retries. A switch to a missing Codex installation is saved for setup at the next ticket boundary. External harness/model/effort commands also defer installation and updates while a queue is running in the same repository. Externally edited execution settings are read at each boundary; invalid settings pause the queue. Correct the JSON and retry, or cancel the queue and use the terminal commands to repair selections.

## Configuration and migration

Iteris creates `.iteris.json` in the project root, inferring `repo` from a GitHub Git remote when possible:

```json
{
  "version": 2,
  "harness": "claude",
  "setupComplete": false,
  "harnesses": {
    "claude": {
      "model": "opus",
      "effort": "xhigh",
      "flags": ["--dangerously-skip-permissions"]
    },
    "codex": {
      "flags": []
    }
  },
  "repo": "org/repo-name",
  "provider": "github",
  "todoStatus": "Todo",
  "baseBranch": "main",
  "timeout": 7200,
  "planMode": true,
  "qualityChecks": ["npm run typecheck", "npm test"],
  "review": {"mode": "standard", "maxRepairCycles": 2, "allowNoChecks": false},
  "pr": {"draft": false, "addLabelOnOpen": "in-review"}
}
```

For ordinary repository issues, add `"githubSource": "issues"` to skip Project discovery and its `read:project` permission requirement. The default, `"auto"`, uses a configured/discovered Project when available and automatically saves `"githubSource": "issues"` before fetching open repository issues when no Projects are visible. Later runs skip Project discovery. `"projects"` starts with Project discovery and also saves the issues fallback if no Projects are found. In issues mode, `projectNumber` and `todoStatus` do not filter the list: all open issues are shown, pull requests are excluded, and you choose which tickets to run. Issues are ordered by `p0`, `p1`, `p2`, then oldest first. Explicit project lookup failures and authentication errors are reported instead of silently changing sources.

Choose Codex's model and effort through its picker to use the current account catalog. Trello options remain `trello.boardId`, `trello.listId`, and `trello.moveOnComplete`.

Legacy configurations migrate automatically on load:

- Save an unchanged backup at `.iteris.json.v1.bak` without overwriting an existing backup.
- Set version 2, preselect Claude, and move `claudeFlags` into `harnesses.claude.flags`.
- Preserve repository, ticket-source, quality-check, PR, and unknown settings. Previously inherited model/effort remain unset until setup.
- Run the new setup once. Validate before atomically replacing the original file.

Invalid JSON, unsupported future versions, and conflicting custom flags produce errors without overwriting the configuration. Use the structured model/effort fields instead of flags that override Iteris's selection, transport, or phase permissions. To undo migration, restore the backup and use an older Iteris version.

`planMode: true` now means **plan, then implement automatically**. Planning is a separate read-only/restricted-tools phase, saved as `plan.md`. Implementation receives that plan; review executes separately. Set `planMode: false` to implement directly. `timeout` defaults to 7200 seconds (two hours) and applies separately to planning, implementation, and PR-description generation; summary has a one-minute limit. Review uses separate time allowances for the checks stage, concurrent investigation stage, verification stage, and each repair/recovery stage: 900 seconds per stage in standard mode or 1800 in deep mode, capped by `timeout`. Set `review.timeout` to override that per-stage allowance. Expensive investigation cannot consume the time needed to verify or repair findings. Each repair round receives fresh stage allowances; at most `maxRepairCycles` repairs/recoveries run (two by default). The total review can therefore exceed `review.timeout`, but is bounded by at most `3 + 4 * maxRepairCycles` stage allowances, plus process termination and local bookkeeping. Existing configurations retain their explicit timeout; set `"timeout": 7200` to use two hours. PR descriptions and summaries use the selected harness with restricted permissions.

## Execution and state

For each selected ticket, Iteris:

1. Optionally generates a plan.
2. Asks the harness to create or resume `iteris/<ticket-id>-<slug>`, implement, check, and commit locally.
3. Runs host-owned quality checks, independent correctness and maintainability reviews, and a fresh finding verifier. Sensitive paths also receive a risk review.
4. If needed, gives confirmed blockers to a separate repair session, then reviews and checks the new commit again (at most two repair cycles).
5. After review passes, pushes the exact reviewed commit and verifies the remote branch and base. A fresh, read-only harness writes the PR narrative; Iteris appends the authoritative review report. Existing PRs retain their authored description and receive an updated review section.
6. Applies completion actions and generates a summary.

Implementation and repair require a clean process exit and an assistant completion marker; tool output cannot signal completion. Review instead requires validated JSON reports, complete file and acceptance coverage, verified findings, and successful configured checks tied to the final commit. Planning and PR-description generation require a clean exit and non-empty assistant output. Failed, blocked, incomplete, or timed-out tickets offer retry or skip, preserving the underlying error. Blocked and incomplete reviews never open ready PRs or apply completion actions. An explicit retry starts a new bounded review attempt and resumes saved investigation passes and successful host checks from an interrupted attempt when their exact inputs still match. Failed checks and failed or malformed reviewer responses are never reused. Verification runs again before shipping, unless the entire final review was already verified and passed. Within the running queue, retries reuse completed planning and implementation. Completed review evidence can also survive a restart: reuse requires the same clean branch, commit, base, ticket, plan, selected reviewer, policy, and configured checks. Investigation checkpoints also bind to the exact supplied check evidence. Standalone audits always run fresh checks and reviewers. Changed inputs require another review. Iteris checks for an already-created branch PR before generating a description. Iteris detects the remote default branch for configurations without `baseBranch` and checks that the configured base exists before starting the queue. Cancellation terminates the active process and records a stale run. A repository run lock prevents overlapping queues. If Iteris was forcibly killed and reports a stale lock, remove `.iteris/active.json` after confirming that the previous process has stopped.

State lives in `.iteris/runs/<ticket-id>-<slug>/`:

| File | Content |
| --- | --- |
| `status.md` | Phase, result, branch, PR, harness, model, effort, timing, and failure reason |
| `execution.json` | The ticket's selected harness/model/effort |
| `prompt.md` | Implementation prompt |
| `plan.md` | Generated plan when planning is enabled |
| `log.txt` | Normalized harness output |
| `summary.md` | Best-effort session summary |
| `review/review.md` | Human-readable readiness report |
| `review/result.json` | Typed outcome and commit-bound evidence |
| `review/context.json`, `findings.json`, `checks.json` | Latest review inputs, findings, and command results |
| `review/attempts/<id>/round-*/` | Prior inputs, independent reports, verification, check output, and repair results |
| `review/checkpoints/` | Validated investigation passes, successful check batches, and supplemental check commands for resuming interrupted reviews |

## Code review

The review outcomes are **passed**, **blocked**, and **incomplete**. A completion marker alone cannot pass review. Missing context, malformed output, omitted files or requirements, timeouts, dirty working trees, and changed commits fail closed. Critical/high findings, missing explicit requirements, verified policy violations, material structural regressions, and failing required checks block shipping. Medium/low advice remains visible without forcing unrelated rewrites. Review is automated readiness evidence; it does not approve or merge PRs.

Configure real repository commands in `qualityChecks`. An empty list produces an incomplete review and, for Node projects, suggestions from package scripts. For a change that explicitly requires no executable validation, set `review.allowNoChecks: true`; the report still says no checks ran. Existing configurations with no checks need this decision before they can ship. Commands come from configuration or the bounded recovery step; the host records their actual exit codes and outputs. A check that edits tracked source invalidates the snapshot.

Review configuration is optional and receives defaults:

```json
"review": {
  "mode": "standard",
  "maxRepairCycles": 2,
  "timeout": 900,
  "allowNoChecks": false
}
```

`deep` always adds the risk specialist. Standard mode also adds it for paths suggesting auth, credentials, migrations, shared types, subprocesses, or concurrency; this routing is a heuristic and the main pass always checks security. All required investigators run concurrently (up to three), including the risk specialist. Verification starts after they finish and has its own time allowance. Persistent blockers stop repairs early. Review and check settings edited during a queue apply at the next ticket; retries retain the active ticket settings.

Valid incomplete reviews and unverified acceptance criteria enter a recovery step within the same `maxRepairCycles` budget. Recovery can commit code or test-setup fixes and request additional local test commands; the host runs those commands and configured checks on the resulting commit before a fresh independent review. Evidence-only recovery does not require an empty commit. Discovered validation commands are saved with the review scope and survive retries and restarts; code repairs still require fresh checks and review on the new commit. Repeated gaps stop early, and unavailable external prerequisites are reported explicitly. Malformed reports, wrong-commit evidence, cancellation, and timeouts remain incomplete. Standalone review/audit never runs recovery.

Add `REVIEW.md` to the base branch for domain invariants and path-specific review expectations. Review uses that base version supplied inline as `context.policy`, so a branch cannot weaken its own policy. An absent base policy is allowed and is not itself an incomplete review. A finding must cite the applicable rule. File length is an investigation signal, not an automatic blocker. Reviews see the full ticket and relevant plan, inspect committed files and callers, and must justify findings through concrete causal evidence. The verifier can confirm findings, reject false positives, or mark a finding as a duplicate of one confirmed canonical finding; it must explicitly verify that previous blockers were fixed.

To review an existing branch without implementation, automatic repairs, pushing, or PR creation:

```bash
iteris review
iteris review deep
iteris review audit
```

These commands run configured checks and save results under `.iteris/reviews/`. Audit forces deep inspection and reports structural proposals. They exit with status 1 for blocked/incomplete review. They use your configured base branch and provider model, but require no GitHub authentication step. They have no linked ticket, so the report evaluates the branch's behavior and compatibility rather than claiming external ticket acceptance.

Reviewers inspect disposable detached copies. Claude receives only read/search tools, no MCP servers, and a per-run hook-disable setting; administrator-managed hooks remain subject to the CLI's managed policy. Codex uses its read-only sandbox. These are harness restrictions, not an OS isolation guarantee for arbitrary project tooling. Reproduction evidence comes from configured commands, additional local commands requested by recovery, and code tracing. Recovery commands run with the same local permissions and deadline as configured checks. Keep autonomous implementation, repair, and quality commands in an appropriate environment.

Unexpected edits are preserved and stop review. Commits with diffs above 240,000 characters require splitting instead of silent truncation. If the remote base advances before publication finishes, fetch it and retry so the review uses the new base. Review artifacts are local and are not committed; the useful summary is embedded in the PR body.

## Review evaluation

The deterministic tests cover the gate and process lifecycle; they do not measure model accuracy. A separate [30-case synthetic corpus](eval/review/README.md) contains seeded defects, clean controls, acceptance gaps, and structural regressions. Run it explicitly using your local provider and human-adjudicate findings before claiming precision or recall improvements:

```bash
npm run eval:review -- --case zero-default --harness codex
```

## Development

TypeScript, Node.js 22+, React/Ink, Octokit, and Zod. Package manager: pnpm (npm also works).

```bash
npm run typecheck
npm test
```

Tests build the application and use isolated fake CLI executables for discovery, update/login behavior, subprocess failures, configuration migration, setup, switching, and complete ticket lifecycles. They do not need real model calls or create real PRs.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/Oscar-Codes-Life/Iteris/main/install.sh | bash -s -- --uninstall
```

## License

[MIT](LICENSE) © 2026 Oscar Gallo

### Custom REST endpoints

Run `iteris setup`, choose **Custom REST endpoint**, and enter the endpoint URL and the **name** of your API-key environment variable. Export the value in your shell before running Iteris:

```sh
export CUSTOM_API_KEY='your-api-key'
iteris
```

The provider settings in `.iteris.json` look like this (alongside your existing repository and harness settings):

```json
{
  "provider": "custom",
  "custom": {
    "endpoint": "https://api.example.com/tasks",
    "apiKeyEnv": "CUSTOM_API_KEY",
    "itemsPath": "data.tasks",
    "idPath": "ticket.id"
  }
}
```

`itemsPath` is a dot-separated path to the response array; omit it or use `""` when the response itself is an array. `idPath` is optional: without it, Iteris checks each item's top-level `id`, then `key`. During setup, enter `-` to clear a previously saved path.

On the first run, Iteris makes one GET request with `Authorization: Bearer <environment value>`. Later runs validate and reuse the downloaded tasks and attachments, without requesting the endpoint or running conversion again. Run `iteris refresh` to fetch and convert the latest tasks. A changed endpoint or mapping starts a new import. Downloads created by older Iteris versions require a one-time confirmation before reuse because their manifests do not identify the source endpoint.

The endpoint must return all items in one JSON response; pagination and endpoint redirects are not supported. The request timeout is 30 seconds and the response limit is 10 MiB. Credentials are not stored in configuration or passed to the conversion harness. Reusing downloaded tasks does not require the REST API key.

Each item is converted using your selected Claude Code or Codex model and effort, independently of the execution `planMode` setting. Both conversion stages use Zod validation and retry invalid output once. Conversion uses the configured phase timeout. Text, Markdown, JSON, CSV, PNG, JPEG, and WebP attachments are downloaded and analyzed. Other formats and failed downloads are listed with warnings. Downloads are limited to 10 MiB and 30 seconds per attachment, and 100 MiB per import. The Bearer token is sent only to the endpoint's origin; other attachment origins must accept public or signed URLs.

Successful imports produce a directory such as:

```text
.tasks/2026-09-09T14-30-45.123+0300/
  task1.md
  task2.md
  manifest.json
  attachments/
```

Iteris prints that location, then opens the normal task picker. Nothing is published until every task validates. Generated files are locally excluded from Git through its `info/exclude` file. When a REST item includes an `identifier` (for example, `ABC-123`), its PR title uses `ABC-123: Task title`. The identifier is preserved in downloaded tasks; run `iteris refresh` to pick it up for older downloads. Items without an identifier keep the task title as their PR title.

GitHub authentication is still required: selected custom tasks use the normal branch, review, and PR workflow, without closing or labeling GitHub issues or updating the custom API.

Tasks with IDs retain their local number, branch, and execution history when edited. Numeric `123` and string `"123"` are the same ID. Tasks without IDs use a fingerprint of their source JSON; object-key order does not matter, but content edits create a new task. Mixed responses with and without IDs are supported. Identical duplicates are collapsed; conflicting records with the same ID reject the import. An item that later gains an ID becomes a new identity.

Unchanged completed tasks are unchecked by default. After a refresh, edited tasks with stable IDs show **Changed** and are checked for another run. Identity allocation and the download cache reference live in `.iteris/custom/`; execution records live in `.iteris/runs/custom-{identity}/`, with earlier attempts retained in `history/`. Keep `.iteris/` and `.tasks/` to preserve downloaded tasks, identity allocation, and completion history. If saved files are missing or invalid, Iteris asks you to run `iteris refresh` rather than silently downloading and converting everything again.

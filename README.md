# Iteris

![Iteris Cover](assets/Iteris-cover.png)

Iteris pulls tickets from **GitHub Issues, GitHub Projects, or Trello**, implements them with **Claude Code or Codex**, reviews the changes, and opens pull requests. It runs locally with a live terminal UI.

> **Experimental autonomous agent.** Implementation and review use full-access Codex execution by default; Claude retains its configured permission flags (the default skips permission prompts). These agents can run commands and change files beyond the repository. Use a controlled environment appropriate for autonomous execution.

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

Changes are saved immediately and apply to the **next ticket**. An active ticket uses the same selection through planning, implementation, review, summary, and retries. A switch to a missing Codex installation is saved for setup at the next ticket boundary. External harness/model/effort commands also defer installation and updates while a queue is running in the same repository. Externally edited execution settings are read at each boundary; invalid settings pause the queue. Correct the JSON and retry, or cancel the queue and use the terminal commands to repair selections.

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
  "qualityChecks": ["npm test"],
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

`planMode: true` now means **plan, then implement automatically**. Planning is a separate read-only/restricted-tools phase, saved as `plan.md`. Implementation receives that plan; review executes separately. Set `planMode: false` to implement directly. `timeout` defaults to 7200 seconds (two hours) and applies separately to planning, implementation, and review; summary has a one-minute limit. Existing configurations retain their explicit timeout; set `"timeout": 7200` to use two hours. Summaries use the selected harness with restricted permissions and are best-effort.

## Execution and state

For each selected ticket, Iteris:

1. Optionally generates a plan.
2. Asks the harness to create `iteris/<ticket-id>-<slug>`, implement, check, commit, and push.
3. Runs a review agent using the same harness/model/effort to review and open the PR.
4. Looks up the PR, applies completion actions, and generates a summary.

Success requires a clean process exit and an assistant completion marker; tool output cannot signal completion. Planning, implementation, and review each use the configured `timeout` (seconds). Failed or timed-out tickets offer retry or skip, preserving the underlying error. Within the running queue, retries reuse completed planning, implementation, and review phases; restarting Iteris starts a new attempt. Iteris detects the remote default branch for configurations without `baseBranch` and checks that the configured base exists before starting the queue. Cancellation terminates the active process and records a stale run. A repository run lock prevents overlapping queues. If Iteris was forcibly killed and reports a stale lock, remove `.iteris/active.json` after confirming that the previous process has stopped.

State lives in `.iteris/runs/<ticket-id>-<slug>/`:

| File | Content |
| --- | --- |
| `status.md` | Phase, result, branch, PR, harness, model, effort, timing, and failure reason |
| `execution.json` | The ticket's selected harness/model/effort |
| `prompt.md` | Implementation prompt |
| `plan.md` | Generated plan when planning is enabled |
| `log.txt` | Normalized harness output |
| `summary.md` | Best-effort session summary |

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

NOT YET

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

Iteris makes one GET request with `Authorization: Bearer <environment value>`. The endpoint must return all items in one JSON response; pagination and endpoint redirects are not supported. The request timeout is 30 seconds and the response limit is 10 MiB. Credentials are not stored in configuration or passed to the conversion harness.

Each item is converted using your selected Claude Code or Codex model and effort, independently of the execution `planMode` setting. Both conversion stages use Zod validation and retry invalid output once. Conversion uses the configured phase timeout. Text, Markdown, JSON, CSV, PNG, JPEG, and WebP attachments are downloaded and analyzed. Other formats and failed downloads are listed with warnings. Downloads are limited to 10 MiB and 30 seconds per attachment, and 100 MiB per import. The Bearer token is sent only to the endpoint's origin; other attachment origins must accept public or signed URLs.

Successful imports produce a directory such as:

```text
.tasks/2026-09-09T14-30-45.123+0300/
  task1.md
  task2.md
  manifest.json
  attachments/
```

Iteris prints that location, then opens the normal task picker. Nothing is published until every task validates. Generated files are locally excluded from Git through its `info/exclude` file. GitHub authentication is still required: selected custom tasks use the normal branch, review, and PR workflow, without closing or labeling GitHub issues or updating the custom API.

Tasks with IDs retain their local number, branch, and execution history when edited. Numeric `123` and string `"123"` are the same ID. Tasks without IDs use a fingerprint of their source JSON; object-key order does not matter, but content edits create a new task. Mixed responses with and without IDs are supported. Identical duplicates are collapsed; conflicting records with the same ID reject the import. An item that later gains an ID becomes a new identity.

Unchanged completed tasks are unchecked by default. Edited tasks with stable IDs show **Changed** and are checked for another run. Identity allocation lives in `.iteris/custom/`; execution records live in `.iteris/runs/custom-{identity}/`, with earlier attempts retained in `history/`. Keep `.iteris/` to preserve identity allocation and completion history.

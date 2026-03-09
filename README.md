# Iteris

![Iteris Cover](assets/Iteris-cover.png)

> **⚠️ EXPERIMENTAL AGENT — USE AT YOUR OWN RISK**
>
> Iteris is an **experimental** autonomous agent. We are **not responsible** for any consequences resulting from its use.
>
> It runs Claude Code with `--dangerously-skip-permissions`, which gives it **unrestricted access to your system** — it can execute arbitrary commands, modify or delete files, install packages, and more. Only run it in environments you are comfortable exposing.

A specialized autonomous software engineering agent that pulls tickets from **GitHub Issues or Trello boards**, ships them one by one via Claude Code, and manages the full lifecycle from branch to PR.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Oscar-Codes-Life/Iteris/main/install.sh | bash
```

This clones Iteris to `~/.iteris`, builds it, and symlinks the binary so `iteris` is available globally.

**Prerequisites:**
- **Node.js 22+**
- **Claude Code** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **`GITHUB_TOKEN`** set as an environment variable

**Re-run to update** — the script pulls the latest changes and rebuilds.

**Uninstall:**

```bash
curl -fsSL https://raw.githubusercontent.com/Oscar-Codes-Life/Iteris/main/install.sh | bash -s -- --uninstall
```

## What It Does

Iteris takes GitHub issues labeled `Todo` (or Trello cards from a board/list), works through them sequentially using Claude Code as a subprocess, and lands each one as an open PR — with full state tracking and a live terminal UI.

No GitHub Actions. No YAML pipelines. Just a local process you run.

## Prerequisites

1. **Claude Account** — preferably the [Max plan](https://claude.ai) for higher usage limits
2. **Node.js 22+**
3. **Claude Code** installed and authenticated
4. **`GITHUB_TOKEN`** set as a global environment variable (required for GitHub provider)

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

A fine-grained personal access token scoped to the target repo is recommended. Required permissions:
- `issues: read`
- `contents: write`
- `pull_requests: write`

5. **`TRELLO_API_KEY`** and **`TRELLO_TOKEN`** set as global environment variables (required only when using Trello)

```bash
export TRELLO_API_KEY=your_trello_api_key
export TRELLO_TOKEN=your_trello_token
```

Get your API key and generate a token from the [Trello Power-Ups admin page](https://trello.com/power-ups/admin).

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (strict mode)
- **CLI UI**: [Ink](https://github.com/vadimdemedes/ink) (React for terminals)
- **GitHub**: Octokit (`@octokit/rest`)
- **Package manager**: pnpm

## How It Works

### Step 1 — Choose your GitHub Project

![Step 1: Choose your GitHub Project](assets/step1.jpg)

Iteris discovers all GitHub Projects in your organization and presents them for selection.

### Step 2 — Select the project to work on

![Step 2: Select the project to work on](assets/step2.jpg)

Navigate the list of projects with arrow keys and press Enter to select one. Iteris fetches tickets with the configured status (e.g. "Todo").

### Step 3 — Select your tickets

![Step 3: Select your tickets](assets/step3.jpg)

Pick which tickets to build from the available list. Use Space to toggle and Enter to confirm.

### Step 4 — Watch tickets get worked on

![Step 4: Watch tickets get worked on](assets/step4.jpg)

Iteris works through each ticket sequentially — creating branches, spawning Claude Code, implementing changes, and opening PRs. The live UI shows status, branch names, and PR numbers.

<details>
<summary><strong>Under the hood</strong></summary>

For each ticket, Iteris:
1. Creates a branch: `iteris/<ticket-id>-<slug>`
2. Spawns a Claude Code instance with the ticket context
3. Claude Code implements the changes, runs quality checks, commits, pushes, and opens a PR
4. Iteris detects the completion signal (`<task>done</task>`) and moves to the next ticket

</details>

## Configuration

Create `.iteris.json` at the project root:

```json
{
  "repo": "org/repo-name",
  "todoLabel": "Todo",
  "baseBranch": "main",
  "timeout": 1200,
  "claudeFlags": ["--dangerously-skip-permissions"],
  "qualityChecks": ["tsc --noEmit", "eslint .", "vitest run"],
  "pr": {
    "draft": false,
    "addLabelOnOpen": "in-review"
  },
  "trello": {
    "boardId": "optional_board_id",
    "listId": "optional_list_id",
    "moveOnComplete": "Done"
  }
}
```

## State Tracking

Iteris maintains state in `.iteris/runs/<ticket-id>-<slug>/`:

| File          | Purpose                              |
| ------------- | ------------------------------------ |
| `status.md`   | Current status and metadata          |
| `prompt.md`   | Prompt sent to Claude Code           |
| `log.txt`     | Full stdout/stderr from the instance |

Ticket statuses: `running` → `done` | `stale` | `failed`

## Recommendations

- **Claude Code Max subscription** — Use the Max plan with the latest Opus model for the best performance and higher usage limits.
- **CLAUDE.md file** — Maintain a well-crafted `CLAUDE.md` in your project root with coding conventions, standards, and agent behavior preferences so every spawned instance follows consistent rules.
- **Detailed ticket definitions** — Write thorough, well-explained GitHub issues to maximize one-shot success rate.
- **Small, well-scoped issues** — Break work into small, clearly defined issues rather than large, vaguely described features.

## Project Structure

```
src/
  index.tsx          # Entry point, Ink app root
  agent/
    runner.ts        # Spawn + manage Claude Code instances
    watcher.ts       # Stdout watcher, signal detection
    prompt.ts        # Prompt template expansion
  github/
    tickets.ts       # Fetch + filter GitHub issues
    pr.ts            # Open PRs, manage labels
  state/
    manager.ts       # Create/update state folders and status.md
    progress.ts      # Read/write progress.md
  ui/
    App.tsx          # Main Ink UI component
    TicketRow.tsx    # Per-ticket status row
    LiveLog.tsx      # Streaming Claude Code output panel
  config.ts          # Load + validate config
  types.ts           # Shared TypeScript types
```

## Roadmap

See [roadmap.md](roadmap.md) for planned integrations and upcoming features.

## License

NOT YET

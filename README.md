# Iteris

![Iteris Cover](assets/Iteris-cover.png)

> **⚠️ EXPERIMENTAL AGENT — USE AT YOUR OWN RISK**
>
> Iteris is an **experimental** autonomous agent. We are **not responsible** for any consequences resulting from its use.
>
> It runs Claude Code with `--dangerously-skip-permissions`, which gives it **unrestricted access to your system** — it can execute arbitrary commands, modify or delete files, install packages, and more. Only run it in environments you are comfortable exposing.

A specialized autonomous software engineering agent that pulls GitHub tickets, ships them one by one via Claude Code, and manages the full lifecycle from branch to PR.

## What It Does

Iteris takes GitHub issues labeled `Todo`, works through them sequentially using Claude Code as a subprocess, and lands each one as an open PR — with full state tracking and a live terminal UI.

No GitHub Actions. No YAML pipelines. Just a local process you run.

## Prerequisites

1. **Claude Account** — preferably the [Max plan](https://claude.ai) for higher usage limits
2. **Node.js 22+**
3. **Claude Code** installed and authenticated
4. **`GITHUB_TOKEN`** set as a global environment variable

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

A fine-grained personal access token scoped to the target repo is recommended. Required permissions:
- `issues: read`
- `contents: write`
- `pull_requests: write`

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (strict mode)
- **CLI UI**: [Ink](https://github.com/vadimdemedes/ink) (React for terminals)
- **GitHub**: Octokit (`@octokit/rest`)
- **Package manager**: pnpm

## How It Works

```
GitHub Issue (Todo) → fetch → pick next → spawn Claude Code → implement → push → open PR → next ticket
```

For each ticket, Iteris:
1. Creates a branch: `iteris/<ticket-id>-<slug>`
2. Spawns a Claude Code instance with the ticket context
3. Claude Code implements the changes, runs quality checks, commits, pushes, and opens a PR
4. Iteris detects the completion signal (`<task>done</task>`) and moves to the next ticket

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

## License

NOT YET

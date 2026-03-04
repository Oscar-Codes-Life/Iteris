# Iteris

![Iteris Cover](assets/Iteris-cover.png)

A specialized autonomous software engineering agent that pulls GitHub tickets, ships them one by one via Claude Code, and manages the full lifecycle from branch to PR.

## What It Does

Iteris takes GitHub issues labeled `Todo`, works through them sequentially using Claude Code as a subprocess, and lands each one as an open PR — with full state tracking and a live terminal UI.

No GitHub Actions. No YAML pipelines. Just a local process you run.

## Prerequisites

1. **Node.js 22+**
2. **Claude Code** installed and authenticated
3. **`GITHUB_TOKEN`** set as a global environment variable

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

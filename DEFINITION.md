# Iteris — Spec

> A specialized autonomous software engineering agent that pulls GitHub tickets, ships them one by one via Claude Code, and manages the full lifecycle from branch to PR.

---

## Overview

Iteris sits between a simple agent loop (Ralph, Brandon's loop) and a full platform (OpenClaw). It is not a general-purpose assistant. It does one thing: take GitHub issues in `Todo`, work them autonomously via Claude Code, and land them as reviewed PRs — with full state tracking and a clean CLI UI powered by Ink.

No GitHub Actions. No YAML pipelines. Just a local process you run.

---

## Positioning

| Tool           | What it is                                                                           |
| -------------- | ------------------------------------------------------------------------------------ |
| Ralph          | Minimal bash loop, file-based memory, story-per-iteration                            |
| Brandon's Loop | Bash loop with explicit process killing via watcher                                  |
| **Iteris**     | TypeScript CLI agent, GitHub-native, full ticket lifecycle with branch/PR management |
| OpenClaw       | Full personal AI platform, multi-channel, multi-OS, companion apps, gateway          |

Iteris is closer to a focused engineering tool than a platform. It has opinions about the software development workflow and nothing else.

---

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (strict mode)
- **CLI UI**: [Ink](https://github.com/vadimdemedes/ink) (React for terminals)
- **GitHub integration**: Octokit (`@octokit/rest`)
- **Process management**: Node.js `child_process.spawn`
- **Package manager**: pnpm
- **Config**: `.iteris.json` at project root or `~/.iteris/config.json` globally

---

## Prerequisites

Iteris has exactly three prerequisites. No Anthropic API key, no OAuth flow, no credential management beyond what you already have set up.

**1. Node.js 22+**
```bash
node --version
```

**2. Claude Code installed and authenticated**

Iteris spawns Claude Code as a local subprocess. It inherits whatever authentication Claude Code already has on your machine. Iteris has no knowledge of and no dependency on your Anthropic credentials.
```bash
claude --version
```

**3. `GITHUB_TOKEN` set as a global environment variable**

This is the only credential Iteris manages. It is used exclusively for GitHub operations: fetching issues, creating PRs, and managing labels via Octokit.

Add to your `~/.zshrc` or `~/.bashrc`:
```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

A **fine-grained personal access token** scoped to the target repository is strongly recommended over a classic token. Iteris only requires these permissions:
- `issues: read`
- `contents: write`
- `pull_requests: write`

Iteris will exit with a clear error message on startup if `GITHUB_TOKEN` is not set or does not have sufficient permissions.

---

## Core Concepts

### Ticket
A GitHub Issue in the configured repository with a label matching the configured `todoLabel` (default: `Todo`). Each ticket maps to one Claude Code instance, one branch, and one PR.

### Instance
A spawned Claude Code child process assigned to a single ticket. Each instance gets a fresh context. Iteris manages its lifecycle: spawn, watch, kill on completion signal.

### State Folder
For every ticket processed, Iteris creates a folder at `.iteris/runs/<ticket-id>-<slug>/` containing:
- `status.md` — current status and metadata
- `prompt.md` — the expanded prompt passed to Claude Code
- `log.txt` — stdout/stderr from the Claude Code instance

### Completion Signal
Claude Code signals task completion by printing `<task>done</task>` to stdout. The watcher detects this, kills the process cleanly, and transitions the ticket state to `done`.

---

## Ticket Lifecycle

```
GitHub Issue (Todo)
        │
        ▼
   [fetch tickets]
        │
        ▼
   pick next ticket (priority order)
        │
        ▼
   create state folder + status.md (status: running)
        │
        ▼
   spawn Claude Code instance
   - create branch: iteris/<ticket-id>-<slug>
   - checkout branch
   - implement ticket
   - run quality checks (typecheck, lint, test)
   - commit changes
   - push branch
   - open PR with ticket reference
   - print <task>done</task>
        │
        ▼
   watcher detects <task>done</task>
        │
        ▼
   kill Claude Code process
        │
        ▼
   update status.md (status: done)
        │
        ▼
   move to next ticket
        │
        ▼
   all tickets done → exit
```

---

## State & Memory

### Folder Structure

```
.iteris/
  config.json          # local project config (overrides global)
  runs/
    42-add-login/
      status.md        # current status + metadata
      prompt.md        # prompt sent to Claude Code
      log.txt          # full stdout/stderr log
    87-fix-nav-bug/
      status.md
      prompt.md
      log.txt
  progress.md          # append-only learnings across all runs (like Ralph's progress.txt)
```

### Status Values

| Status    | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `running` | Claude Code instance is active                                        |
| `done`    | Completed successfully, PR opened                                     |
| `stale`   | Process died without signaling done (no `<task>done</task>` received) |
| `failed`  | Quality checks failed or explicit error                               |

### status.md Schema

```md
# Ticket #42 — Add login page

**Status**: done
**Branch**: iteris/42-add-login
**PR**: https://github.com/org/repo/pull/103
**Started**: 2026-03-04T10:22:00Z
**Finished**: 2026-03-04T10:41:00Z
**Iterations**: 1

## Notes
<!-- Claude Code learnings appended here by the instance -->
```

---

## Process Management

### Spawning

```typescript
const proc = spawn('claude', [
  '--dangerously-skip-permissions',
  '--print'
], {
  stdio: ['pipe', 'pipe', 'pipe']
});

proc.stdin.write(expandedPrompt);
proc.stdin.end();
```

### Watcher

A per-instance watcher reads stdout in real time. On detection of `<task>done</task>`:

1. Kill the process (`proc.kill('SIGTERM')`)
2. Wait for process to exit (`proc.on('exit', ...)`)
3. Update `status.md` to `done`
4. Move to next ticket

### Timeout

Each instance has a configurable timeout (default: 20 minutes). On timeout:

1. Kill the process
2. Update `status.md` to `stale`
3. Log timeout event to `log.txt`
4. Continue to next ticket

### Clean Interrupt

On `SIGINT` / `SIGTERM` (Ctrl+C):

1. Kill active Claude Code instance
2. Mark current ticket as `stale`
3. Flush all logs
4. Exit cleanly

---

## Prompt Template

Each instance receives an expanded prompt built from the ticket data:

```md
You are an autonomous software engineer working on a GitHub repository.

## Your Task
Ticket: #{{ticket.number}} — {{ticket.title}}
Description:
{{ticket.body}}

## Instructions
1. Create and checkout a new branch: `iteris/{{ticket.number}}-{{ticket.slug}}`
2. Implement the changes described in the ticket
3. Run quality checks: typecheck, lint, tests
4. If checks pass: commit all changes with message `fix: #{{ticket.number}} — {{ticket.title}}`
5. Push the branch to origin
6. Open a PR targeting `main` with:
   - Title: `{{ticket.title}}`
   - Body referencing the ticket: `Closes #{{ticket.number}}`
7. When fully done, print exactly: <task>done</task>

## Memory from Previous Runs
{{progress.md contents}}
```

---

## GitHub Integration

- Authenticates exclusively via the `GITHUB_TOKEN` global environment variable — no other credentials required
- Iteris does not manage or require any Anthropic API key; Claude Code runs as a local subprocess using its own existing authentication
- Fetches issues with label matching `todoLabel` config, sorted by priority label then creation date
- After PR is created, adds label `in-review` to the issue (optional, configurable)
- Never touches GitHub Actions or workflow files

---

## CLI Interface (Ink)

The UI renders live in the terminal using Ink. No static log spam.

### Main View

```
 Iteris  oscarcodeslife/my-repo  3 tickets remaining

 ✅  #38 — Fix auth redirect        done      branch: iteris/38-fix-auth-redirect   PR #101
 ✅  #41 — Add dark mode toggle     done      branch: iteris/41-dark-mode            PR #102
 ⚙️   #42 — Add login page          running   elapsed: 4m 12s

 Claude Code output:
 > Creating branch iteris/42-add-login...
 > Running tsc --noEmit...
 > Tests passing (42/42)...
```

### Idle / Done View

```
 Iteris  All tickets complete 🎉

 ✅  #38   Fix auth redirect       PR #101
 ✅  #41   Add dark mode toggle    PR #102
 ✅  #42   Add login page          PR #103

 Total time: 1h 12m
```

### Error / Stale View

```
 ⚠️   #44 — Refactor API layer     stale     timed out after 20m — skipped
```

---

## Configuration

### `.iteris.json`

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

---

## File Structure

```
iteris/
  src/
    index.tsx          # entry point, Ink app root
    agent/
      runner.ts        # spawn + manage Claude Code instances
      watcher.ts       # stdout watcher, signal detection
      prompt.ts        # prompt template expansion
    github/
      tickets.ts       # fetch + filter GitHub issues
      pr.ts            # open PRs, manage labels
    state/
      manager.ts       # create/update state folders and status.md
      progress.ts      # read/write progress.md
    ui/
      App.tsx          # main Ink UI component
      TicketRow.tsx    # per-ticket status row
      LiveLog.tsx      # streaming Claude Code output panel
    config.ts          # load + validate config
    types.ts           # shared TypeScript types
  .iteris.json         # project config (gitignored)
  package.json
  tsconfig.json
```

---

## What Iteris Is Not

- Not a GitHub Actions replacement — it runs locally
- Not a general-purpose AI assistant — it only ships GitHub tickets
- Not a multi-agent system — one ticket, one instance, sequential
- Not a platform — no gateway, no channels, no companion apps
- Not opinionated about your stack — quality check commands are fully configurable

---

## Out of Scope (v1)

- Parallel ticket processing (multiple simultaneous Claude Code instances)
- Web dashboard
- Slack / Discord notifications
- Auto-retry on stale tickets
- Self-healing (detecting bad code and re-running)
- Support for GitLab or Linear

---

## Success Criteria

A successful Iteris run takes a list of GitHub issues labeled `Todo`, works through them one by one without human intervention, and leaves behind a set of open PRs — each on its own branch, each referencing the original ticket, each with a clean commit history and passing quality checks.
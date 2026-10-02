import { Box, Text } from "ink";
import type { TicketState } from "../types.js";

const statusIcons: Record<string, string> = {
  pending: "○",
  planning: "◌",
  summarizing: "◌",
  running: "◉",
  reviewing: "⊙",
  "creating-pr": "◉",
  done: "✓",
  stale: "⚠",
  failed: "✗",
  blocked: "!",
  incomplete: "?",
  waiting: "◷",
  cancelled: "−",
};

const statusColors: Record<string, string> = {
  pending: "gray",
  planning: "cyan",
  summarizing: "cyan",
  running: "yellow",
  reviewing: "cyan",
  "creating-pr": "cyan",
  done: "green",
  stale: "yellow",
  failed: "red",
  blocked: "red",
  incomplete: "yellow",
  waiting: "yellow",
  cancelled: "gray",
};

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

type TicketRowProps = {
  state: TicketState;
};

export function TicketRow({ state }: TicketRowProps) {
  const icon = statusIcons[state.status] ?? "?";
  const color = statusColors[state.status] ?? "white";

  return (
    <Box gap={1}>
      <Text color={color}>{icon}</Text>
      <Text color={color} bold>
        #{state.ticket.number}
      </Text>
      <Text>{state.ticket.title}</Text>
      <Text color={color}>{state.status}</Text>
      {(["planning", "running", "reviewing", "creating-pr", "summarizing"].includes(state.status)) && (
        <Text dimColor>elapsed: {formatElapsed(state.elapsedMs)}</Text>
      )}
      {state.branch && state.status !== "pending" && (
        <Text dimColor>branch: {state.branch}</Text>
      )}
      {state.prNumber && <Text color="cyan">PR #{state.prNumber}</Text>}
      {state.reviewPending && <Text color="yellow">({state.reviewPending})</Text>}
      {state.remaining?.length && <Text dimColor>{state.remaining.length} requirements remaining</Text>}
      {state.failureReason && (["failed", "stale", "blocked", "incomplete", "waiting"].includes(state.status)) && (
        <Text dimColor>({state.failureReason})</Text>
      )}
    </Box>
  );
}

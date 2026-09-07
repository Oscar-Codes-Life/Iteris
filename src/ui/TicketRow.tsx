import { Box, Text } from "ink";
import type { TicketState } from "../types.js";

const statusIcons: Record<string, string> = {
  pending: "○",
  planning: "◌",
  summarizing: "◌",
  running: "◉",
  reviewing: "⊙",
  done: "✓",
  stale: "⚠",
  failed: "✗",
};

const statusColors: Record<string, string> = {
  pending: "gray",
  planning: "cyan",
  summarizing: "cyan",
  running: "yellow",
  reviewing: "cyan",
  done: "green",
  stale: "yellow",
  failed: "red",
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
      {(["planning", "running", "reviewing", "summarizing"].includes(state.status)) && (
        <Text dimColor>elapsed: {formatElapsed(state.elapsedMs)}</Text>
      )}
      {state.branch && state.status !== "pending" && (
        <Text dimColor>branch: {state.branch}</Text>
      )}
      {state.prNumber && <Text color="cyan">PR #{state.prNumber}</Text>}
      {state.failureReason && (state.status === "failed" || state.status === "stale") && (
        <Text dimColor>({state.failureReason})</Text>
      )}
    </Box>
  );
}

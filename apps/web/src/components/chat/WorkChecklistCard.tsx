import { useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleIcon, XIcon } from "lucide-react";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Spinner } from "../ui/spinner";
import { workEntryDisplayLabel } from "./MessagesTimeline.logic";

type StepStatus = "completed" | "in-progress" | "failed" | "pending";

function stepStatus(entry: WorkLogEntry): StepStatus {
  switch (entry.toolLifecycleStatus) {
    case "completed":
      return "completed";
    case "inProgress":
      return "in-progress";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "completed":
      return <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-success" />;
    case "in-progress":
      return <Spinner aria-hidden="true" className="size-4 shrink-0 text-primary" />;
    case "failed":
      return <XIcon aria-hidden="true" className="size-4 shrink-0 text-error" />;
    default:
      return <CircleIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
  }
}

function stepTimestamp(entry: WorkLogEntry, timestampFormat: TimestampFormat): string | null {
  if (!entry.createdAt || !Number.isFinite(Date.parse(entry.createdAt))) {
    return null;
  }
  return formatDayAwareTimestamp(entry.createdAt, timestampFormat);
}

/**
 * Collapsible checklist over an already-projected work group. Reads only the
 * entries the row already renders: no parallel data path, no invented
 * timestamps. Timestamps render only when the entry provides a valid one.
 */
export function WorkChecklistCard({
  entries,
  workspaceRoot,
  timestampFormat,
}: {
  entries: ReadonlyArray<WorkLogEntry>;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
}) {
  // Follow the live state by default: the card opens while work is in progress
  // and collapses once it finishes. A manual toggle wins for the rest of the
  // turn, and resets when the row is remounted for another turn.
  const hasInProgressWork = entries.some((entry) => entry.toolLifecycleStatus === "inProgress");
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? hasInProgressWork;
  if (entries.length === 0) {
    return null;
  }
  const completedCount = entries.filter(
    (entry) => entry.toolLifecycleStatus === "completed",
  ).length;
  const ChevronIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <section
      aria-label="Working on your request"
      className="rounded-[var(--radius)] border border-border bg-card"
    >
      <button
        type="button"
        aria-expanded={expanded}
        data-scroll-anchor-ignore
        onClick={() => setExpandedOverride(!expanded)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius)] p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          Working on your request…
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {completedCount} of {entries.length}
        </span>
        <ChevronIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground motion-reduce:transition-none"
        />
      </button>
      {expanded ? (
        <ul className="space-y-0.5 px-2 pb-2">
          {entries.map((entry) => {
            const status = stepStatus(entry);
            const timestamp = stepTimestamp(entry, timestampFormat);
            return (
              <li key={entry.id} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1">
                <StepIcon status={status} />
                <span className="min-w-0 flex-1 truncate text-sm text-secondary-label">
                  {workEntryDisplayLabel(entry, workspaceRoot)}
                </span>
                {timestamp ? (
                  <span className={cn("shrink-0 text-[11px] text-muted-foreground tabular-nums")}>
                    {timestamp}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

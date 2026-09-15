import type { CirceTaskState } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CirclePlayIcon,
  ClockIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type Tone = { readonly label: string; readonly text: string; readonly dot: string };

export function Panel({
  title,
  hint,
  action,
  children,
}: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
        <div className="ms-auto flex shrink-0 items-center gap-2">{action}</div>
      </header>
      {children}
    </section>
  );
}

export function PanelViewLink({
  onClick,
  label,
  children,
}: {
  readonly onClick: () => void;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="shrink-0 rounded text-xs font-medium text-accent-ink transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

/** Overall health of a stat card, driving the numeral and the ring's lighting. */
export type StatTone = "healthy" | "mixed" | "warning" | "neutral";

const RING_LIT_FILTER =
  "drop-shadow(0 0 5px rgba(224,138,99,0.30)) drop-shadow(0 0 14px rgba(205,104,67,0.14))";

/**
 * Segmented progress ring: each contributing group gets its own arc and its own
 * status colour, so a card reads "mostly healthy" or "partly limited" at a
 * glance instead of showing one undifferentiated arc. The track stays neutral
 * and the ring only lights up when the card is not degraded.
 */
function Ring({
  segments,
  tone,
  children,
}: {
  readonly segments: ReadonlyArray<{ readonly value: number; readonly className: string }>;
  readonly tone: StatTone;
  readonly children: ReactNode;
}) {
  const radius = 25;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const drawn = segments.filter((segment) => segment.value > 0);
  const gap = drawn.length > 1 ? 3 : 0;
  let consumed = 0;
  return (
    <span className="relative grid size-14 shrink-0 place-items-center">
      <svg
        aria-hidden
        className="absolute inset-0 size-14 -rotate-90"
        style={tone === "healthy" || tone === "mixed" ? { filter: RING_LIT_FILTER } : undefined}
        viewBox="0 0 56 56"
      >
        <circle
          className="stroke-border"
          cx="28"
          cy="28"
          fill="none"
          r={radius}
          strokeWidth={2.5}
        />
        {segments.map((segment, index) => {
          const length = total > 0 ? (segment.value / total) * circumference : 0;
          const arc = Math.max(0, length - gap);
          const node =
            arc > 0 ? (
              <circle
                className={segment.className}
                cx="28"
                cy="28"
                fill="none"
                key={index}
                r={radius}
                strokeDasharray={`${arc} ${circumference - arc}`}
                strokeDashoffset={-consumed}
                strokeLinecap="round"
                strokeWidth={2.5}
              />
            ) : null;
          consumed += length;
          return node;
        })}
      </svg>
      <span
        className={cn(
          "relative text-[26px] leading-none font-semibold tabular-nums",
          tone === "warning" ? "text-warning" : "text-foreground",
        )}
      >
        {children}
      </span>
    </span>
  );
}

export function StatCard({
  value,
  label,
  tone,
  segments,
  breakdown,
  onClick,
}: {
  readonly value: number;
  readonly label: string;
  readonly tone: StatTone;
  readonly segments: ReadonlyArray<{ readonly value: number; readonly className: string }>;
  readonly breakdown: ReadonlyArray<{ readonly label: string; readonly dot: string }>;
  readonly onClick: () => void;
}) {
  return (
    <button
      className="group flex min-w-0 items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
      onClick={onClick}
      type="button"
    >
      <Ring segments={segments} tone={tone}>
        {value}
      </Ring>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-semibold tracking-[0.02em] text-foreground">{label}</span>
        <span className="mt-1.5 flex flex-col gap-1">
          {breakdown.map((entry) => (
            <span
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              key={entry.label}
            >
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", entry.dot)} />
              {entry.label}
            </span>
          ))}
        </span>
      </span>
      <ChevronRightIcon className="ms-auto size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

export function ScopeToolbar({
  scopes,
  active,
  onSelect,
  onNewRun,
}: {
  readonly scopes: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly count: number | null;
  }>;
  readonly active: string;
  readonly onSelect: (id: string) => void;
  readonly onNewRun: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
        {scopes.map((scope) => {
          const selected = scope.id === active;
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-xs transition-colors",
                selected
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={scope.id}
              onClick={() => onSelect(scope.id)}
              type="button"
            >
              {scope.label}
              {scope.count === null ? null : (
                <span className="tabular-nums text-muted-foreground">{scope.count}</span>
              )}
            </button>
          );
        })}
      </div>
      <Button className="ms-auto" onClick={onNewRun} size="sm">
        New run
      </Button>
    </div>
  );
}

export type RunBucket = "active" | "queued" | "completed" | "failed";
export type LiveRunRow = {
  readonly key: string;
  readonly status: Tone;
  readonly title: string;
  readonly agent: string;
  readonly device: string;
  readonly bucket: RunBucket;
};

const RUN_TABS: ReadonlyArray<{ readonly id: RunBucket | "all"; readonly label: string }> = [
  { id: "all", label: "All runs" },
  { id: "active", label: "Active" },
  { id: "queued", label: "Queued" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
];

export function RunTable({
  rows,
  emptyLabel,
}: {
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly status: Tone;
    readonly title: string;
    readonly agent: string;
    readonly device: string;
  }>;
  readonly emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="grid min-h-32 place-items-center px-4 py-8 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="circe-section-label text-left">
          <th className="px-4 py-2 font-semibold">Status</th>
          <th className="px-4 py-2 font-semibold">Task</th>
          <th className="px-4 py-2 font-semibold">Agent</th>
          <th className="px-4 py-2 font-semibold">Device</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="border-t border-border/70 hover:bg-muted/40" key={row.key}>
            <td className="whitespace-nowrap px-4 py-2">
              <span className={cn("inline-flex items-center gap-2", row.status.text)}>
                <span aria-hidden className={cn("size-1.5 rounded-full", row.status.dot)} />
                {row.status.label}
              </span>
            </td>
            <td className="max-w-0 px-4 py-2">
              <span className="block truncate font-medium text-foreground">{row.title}</span>
            </td>
            <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{row.agent}</td>
            <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{row.device}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LiveRunsPanel({
  title,
  hint,
  rows,
  onViewAll,
  emptyLabel,
}: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly rows: ReadonlyArray<LiveRunRow>;
  readonly onViewAll: () => void;
  readonly emptyLabel: string;
}) {
  const [tab, setTab] = useState<RunBucket | "all">("all");
  const counts = new Map<RunBucket | "all", number>([["all", rows.length]]);
  for (const row of rows) counts.set(row.bucket, (counts.get(row.bucket) ?? 0) + 1);
  const visible = tab === "all" ? rows : rows.filter((row) => row.bucket === tab);
  const activeTab = RUN_TABS.find((entry) => entry.id === tab);
  return (
    <Panel
      action={
        <PanelViewLink label="View all runs" onClick={onViewAll}>
          View all
        </PanelViewLink>
      }
      hint={hint}
      title={title}
    >
      <div
        aria-label="Filter runs by status"
        className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5"
        role="group"
      >
        {RUN_TABS.map((entry) => {
          const selected = entry.id === tab;
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
                selected
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={entry.id}
              onClick={() => setTab(entry.id)}
              type="button"
            >
              {entry.label}
              <span className="tabular-nums text-muted-foreground">
                {counts.get(entry.id) ?? 0}
              </span>
            </button>
          );
        })}
      </div>
      <RunTable
        emptyLabel={
          rows.length === 0
            ? emptyLabel
            : `No ${activeTab?.label.toLowerCase() ?? "matching"} runs.`
        }
        rows={visible}
      />
    </Panel>
  );
}

function TaskStateIcon({ state, className }: { state: CirceTaskState; className?: string }) {
  switch (state) {
    case "running":
      return <CirclePlayIcon className={className} />;
    case "ready":
      return <ShieldCheckIcon className={className} />;
    case "failed":
    case "interrupted":
      return <CircleAlertIcon className={className} />;
    case "waiting-for-input":
    case "waiting-for-approval":
      return <ClockIcon className={className} />;
  }
}

export function RecentTasks({
  rows,
}: {
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly device: string;
    readonly status: Tone;
    readonly state: CirceTaskState;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <div className="grid min-h-24 place-items-center px-4 py-6 text-center text-sm text-muted-foreground">
        No recent tasks.
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <li
          className="flex items-center gap-3 border-t border-border/70 px-4 py-2 first:border-t-0"
          key={row.key}
        >
          <TaskStateIcon className={cn("size-4 shrink-0", row.status.text)} state={row.state} />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.title}</span>
          <span className="shrink-0 truncate text-xs text-muted-foreground">{row.device}</span>
        </li>
      ))}
    </ul>
  );
}

export function EmptyAgents() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
      <CircleDashedIcon className="size-4" />
      No agents configured on this device.
    </div>
  );
}

export function BrandFooter() {
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-border bg-background px-4 py-2.5 md:px-6">
      <span aria-hidden className="h-px w-10 shrink-0 bg-primary" />
      <span className="circe-section-label truncate">Circe — Your work. Everywhere.</span>
      <span className="circe-section-label ms-auto shrink-0">A more capable you.</span>
    </footer>
  );
}

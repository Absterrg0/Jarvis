import { describeApproval } from "@t3tools/jarvis-core/describeApproval";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  projectTitle: string;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  projectTitle,
  className,
}: ComposerPendingApprovalPanelProps) {
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : "File change";
  const description = describeApproval({
    requestKind: approval.requestKind,
    ...(approval.detail === undefined ? {} : { detail: approval.detail }),
    projectTitle,
  });
  const riskLabel =
    description.risk === "destructive"
      ? "Permanent action"
      : description.risk === "external-effect"
        ? "External action"
        : description.risk === "workspace-write"
          ? "Changes files"
          : description.risk === "read-and-compute"
            ? "Runs locally"
            : description.risk === "read"
              ? "Reads only"
              : "Review carefully";
  const decisionSummary =
    approval.requestKind === "mcp-elicitation" && approval.detail
      ? approval.detail
      : description.spoken;

  return (
    <div
      aria-label={fallbackLabel}
      className={cn(
        "min-w-0 rounded-xl border border-warning/25 bg-warning/5 p-3 text-left",
        className,
      )}
      role="group"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-xs font-semibold text-foreground">Permission needed</span>
        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
          {riskLabel}
        </span>
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
            1 of {pendingCount}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">{decisionSummary}</p>
      {approval.appName ? (
        <span className="mt-2 block max-w-32 shrink truncate text-[11px] font-medium text-foreground">
          {approval.appName}
        </span>
      ) : null}
      <code
        aria-label={detailAriaLabel}
        className="mt-2 block max-h-20 min-w-0 w-full overflow-auto rounded-lg border border-border/50 bg-background/65 px-2.5 py-2 whitespace-pre font-mono text-[11px] text-foreground/85 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.detail || fallbackLabel}
      </code>
    </div>
  );
});

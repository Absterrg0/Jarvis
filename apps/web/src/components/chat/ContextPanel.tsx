import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentMachineKind, ServerProviderModel } from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState, type ComponentType } from "react";

import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { connectionPhaseDotClassName, ConnectionStatusDot } from "../ConnectionStatusDot";

export interface ContextPanelProject {
  readonly title: string;
  readonly subtitle: string | null;
}

export interface ContextPanelDevice {
  readonly label: string;
  readonly machineKind: EnvironmentMachineKind;
  /** Second line of real device facts (os, arch, server version), or null. */
  readonly detail: string | null;
  readonly phase: EnvironmentConnectionPhase;
  readonly statusText: string;
}

export interface ContextPanelAgent {
  readonly providerLabel: string;
  readonly modelName: string;
  /** Derived from real model flags only; null hides the line. */
  readonly subtitle: string | null;
  readonly Icon: ComponentType<{ className?: string }> | null;
}

export interface ContextPanelPlan {
  readonly completed: number;
  readonly total: number;
  /** In-progress step first, then the next pending step; null when none remain. */
  readonly currentStep: string | null;
}

interface ContextPanelProps {
  readonly project: ContextPanelProject | null;
  readonly onAddToProject: (() => void) | null;
  readonly device: ContextPanelDevice | null;
  readonly agent: ContextPanelAgent | null;
  readonly plan: ContextPanelPlan | null;
  readonly onAddTools: () => void;
}

function ContextSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-sm py-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden">
        <span className="circe-section-label">{title}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-2">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Default-model pick shared with the chat header's model display: the
 * default non-custom model first, then any non-custom model, then whatever
 * the provider lists. Null when the provider lists nothing, so the section
 * hides instead of showing a placeholder.
 */
export function selectContextModel(
  models: ReadonlyArray<ServerProviderModel>,
): ServerProviderModel | null {
  return (
    models.find((model) => model.isDefault === true && !model.isCustom) ??
    models.find((model) => !model.isCustom) ??
    models[0] ??
    null
  );
}

/** Subtitle from real model flags only; null hides the line. */
export function describeContextModel(
  model: Pick<ServerProviderModel, "badge" | "isCustom" | "isDefault" | "isLegacy">,
): string | null {
  const flags = [
    model.isDefault === true ? "Default" : null,
    model.badge === "new" ? "New" : null,
    model.isLegacy === true ? "Legacy" : null,
    model.isCustom === true ? "Custom" : null,
  ].filter((flag): flag is string => flag !== null);
  return flags.length > 0 ? flags.join(" · ") : null;
}

export function ContextPanel({
  project,
  onAddToProject,
  device,
  agent,
  plan,
  onAddTools,
}: ContextPanelProps) {
  return (
    <div
      data-context-panel
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4"
    >
      {project ? (
        <ContextSection title="Project context">
          <p className="circe-title text-sm font-semibold text-foreground">{project.title}</p>
          {project.subtitle ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {project.subtitle}
                  </p>
                }
              />
              <TooltipPopup side="top">{project.subtitle}</TooltipPopup>
            </Tooltip>
          ) : null}
          {onAddToProject ? (
            <button
              type="button"
              onClick={onAddToProject}
              className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <PlusIcon className="size-3.5 text-muted-foreground" aria-hidden />
              Add to project…
            </button>
          ) : null}
        </ContextSection>
      ) : null}

      {device ? (
        <ContextSection title="Connected device">
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <EnvironmentMachineIcon kind={device.machineKind} className="size-4.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {device.label}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ConnectionStatusDot
                    dotClassName={connectionPhaseDotClassName(device.phase)}
                    tooltipText={device.statusText}
                  />
                  {device.statusText}
                </span>
              </span>
            </div>
            {device.detail ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <p className="mt-2 truncate text-xs text-muted-foreground">{device.detail}</p>
                  }
                />
                <TooltipPopup side="top">{device.detail}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </ContextSection>
      ) : null}

      {agent ? (
        <ContextSection title="Agent & model">
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              {agent.Icon ? (
                <agent.Icon className="size-4.5" />
              ) : (
                <BotIcon className="size-4.5" aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {agent.modelName}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {agent.subtitle
                  ? `${agent.providerLabel} · ${agent.subtitle}`
                  : agent.providerLabel}
              </span>
            </span>
          </div>
        </ContextSection>
      ) : null}

      <ContextSection title="Integrations">
        <ul className="flex flex-col gap-1">
          <li>
            <button
              type="button"
              onClick={onAddTools}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <PlusIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Add tools…</span>
            </button>
          </li>
        </ul>
      </ContextSection>

      {plan ? (
        <ContextSection title="Task status">
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {plan.completed} of {plan.total} complete
              </p>
              <p className="text-xs font-semibold text-foreground tabular-nums">
                {plan.total === 0 ? 0 : Math.round((plan.completed / plan.total) * 100)}%
              </p>
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={plan.total}
              aria-valuenow={plan.completed}
              aria-label="Task progress"
              className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{
                  width: `${plan.total === 0 ? 0 : Math.min(100, (plan.completed / plan.total) * 100)}%`,
                }}
              />
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <p className="mt-2 truncate text-xs text-foreground">
                    {plan.currentStep ?? "All steps complete"}
                  </p>
                }
              />
              <TooltipPopup side="top">{plan.currentStep ?? "All steps complete"}</TooltipPopup>
            </Tooltip>
          </div>
        </ContextSection>
      ) : null}
    </div>
  );
}

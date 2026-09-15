import type { ProviderDriverKind } from "@t3tools/contracts";
import {
  BotIcon,
  CircleDashedIcon,
  MonitorSmartphoneIcon,
  RefreshCwIcon,
  ServerCogIcon,
  TerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { EmptyAgents, Panel, PanelViewLink, type Tone } from "./CirceOverviewParts";

export type DeviceTab = "overview" | "agents" | "providers" | "permissions" | "logs";

const DEVICE_TABS: ReadonlyArray<{ readonly id: DeviceTab; readonly label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "providers", label: "Providers" },
  { id: "permissions", label: "Permissions" },
  { id: "logs", label: "Logs" },
];

export type DeviceAgentRow = {
  readonly key: string;
  readonly driver: ProviderDriverKind;
  readonly name: string;
  readonly model: string | null;
  readonly tone: Tone;
};

export type DeviceProviderRow = {
  readonly key: string;
  readonly name: string;
  readonly version: string | null;
  readonly modelCount: number;
  readonly tone: Tone;
};

function StatusMark({ tone }: { readonly tone: Tone }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", tone.text)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
      {tone.label}
    </span>
  );
}

function TabStrip({
  tab,
  onTab,
  label,
}: {
  readonly tab: DeviceTab;
  readonly onTab: (tab: DeviceTab) => void;
  readonly label: string;
}) {
  return (
    <div
      aria-label={label}
      className="flex items-center gap-1 overflow-x-auto border-b border-border"
      role="group"
    >
      {DEVICE_TABS.map((entry) => (
        <button
          aria-pressed={tab === entry.id}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-2.5 pb-2 text-xs transition-colors",
            tab === entry.id
              ? "border-accent-ink font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          key={entry.id}
          onClick={() => onTab(entry.id)}
          type="button"
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

export function DevicePanel({
  label,
  online,
  presetLabel,
  tab,
  onTab,
  onOpenConsole,
  stats,
  capabilities,
  agentRows,
  providerRows,
  onRefresh,
  onManageProviders,
}: {
  readonly label: string;
  readonly online: boolean;
  readonly presetLabel: string;
  readonly tab: DeviceTab;
  readonly onTab: (tab: DeviceTab) => void;
  readonly onOpenConsole: () => void;
  readonly stats: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly capabilities: ReadonlyArray<{ readonly label: string; readonly enabled: boolean }>;
  readonly agentRows: ReadonlyArray<DeviceAgentRow>;
  readonly providerRows: ReadonlyArray<DeviceProviderRow>;
  readonly onRefresh: () => void;
  readonly onManageProviders: () => void;
}) {
  let body: ReactNode;
  if (tab === "agents") {
    body =
      agentRows.length > 0 ? (
        <ul className="flex flex-col">
          {agentRows.map((row) => {
            const Icon = PROVIDER_ICON_BY_PROVIDER[row.driver] ?? BotIcon;
            return (
              <li
                className="flex items-center gap-3 border-t border-border/70 px-4 py-2 first:border-t-0"
                key={row.key}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground">
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {row.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.model ?? "No model selected"}
                  </span>
                </span>
                <StatusMark tone={row.tone} />
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyAgents />
      );
  } else if (tab === "providers") {
    body =
      providerRows.length > 0 ? (
        <ul className="flex flex-col">
          {providerRows.map((row) => (
            <li
              className="flex items-center gap-3 border-t border-border/70 px-4 py-2 first:border-t-0"
              key={row.key}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground">
                <ServerCogIcon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {row.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {row.version ? `v${row.version}` : "Version unknown"} · {row.modelCount}{" "}
                  {row.modelCount === 1 ? "model" : "models"}
                </span>
              </span>
              <StatusMark tone={row.tone} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
          <CircleDashedIcon className="size-4" />
          No providers configured on this device.
        </div>
      );
  } else if (tab === "permissions") {
    body = (
      <div className="px-4 py-3">
        <ul className="flex flex-wrap gap-1.5">
          {capabilities.map((capability) => (
            <li
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                capability.enabled
                  ? "border-success/30 bg-success/10 text-success-foreground"
                  : "border-border bg-muted text-muted-foreground",
              )}
              key={capability.label}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  capability.enabled ? "bg-success" : "bg-muted-foreground/50",
                )}
              />
              {capability.label}
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (tab === "logs") {
    body = (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
        <TerminalIcon className="size-4" />
        Live logs are not available in the web client.
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3 px-4 py-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          {stats.map((stat) => (
            <div className="flex min-w-0 flex-col gap-0.5" key={stat.label}>
              <dt className="text-muted-foreground">{stat.label}</dt>
              <dd className="truncate font-medium text-foreground">{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div>
          <div className="circe-section-label mb-2">Quick controls</div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onRefresh} size="xs" variant="secondary">
              <RefreshCwIcon className="size-3.5" /> Refresh
            </Button>
            <Button onClick={onManageProviders} size="xs" variant="secondary">
              <ServerCogIcon className="size-3.5" /> Manage providers
            </Button>
            <Button onClick={onOpenConsole} size="xs" variant="secondary">
              <MonitorSmartphoneIcon className="size-3.5" /> Open console
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Panel
      action={
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={cn("size-2 rounded-full", online ? "bg-success" : "bg-muted-foreground/50")}
          />
          {online ? "Online" : "Offline"}
        </span>
      }
      title={`Device: ${label}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-muted text-muted-foreground">
          <MonitorSmartphoneIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{label}</div>
          <div className="truncate text-xs text-muted-foreground">{presetLabel}</div>
        </div>
        <Button className="ms-auto shrink-0" onClick={onOpenConsole} size="xs" variant="secondary">
          Open console
        </Button>
      </div>
      <div className="px-4">
        <TabStrip label={`Device ${label} sections`} onTab={onTab} tab={tab} />
      </div>
      {body}
    </Panel>
  );
}

export function AgentsOnDevicePanel({
  deviceLabel,
  rows,
  onManage,
}: {
  readonly deviceLabel: string;
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly model: string | null;
    readonly tone: Tone;
  }>;
  readonly onManage: () => void;
}) {
  return (
    <Panel
      action={
        <PanelViewLink label="Manage providers" onClick={onManage}>
          Manage
        </PanelViewLink>
      }
      hint={deviceLabel}
      title="Agents on this device"
    >
      {rows.length === 0 ? (
        <EmptyAgents />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="circe-section-label text-left">
              <th className="px-4 py-2 font-semibold">Agent</th>
              <th className="px-4 py-2 font-semibold">Status</th>
              <th className="px-4 py-2 font-semibold">Model</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t border-border/70 hover:bg-muted/40" key={row.key}>
                <td className="max-w-0 px-4 py-2">
                  <span className="block truncate font-medium text-foreground">{row.name}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  <StatusMark tone={row.tone} />
                </td>
                <td className="max-w-0 px-4 py-2 text-muted-foreground">
                  <span className="block truncate">{row.model ?? "No model selected"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

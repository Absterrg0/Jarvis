import type { ProviderDriverKind } from "@t3tools/contracts";
import { BotIcon, CirclePlayIcon, MonitorSmartphoneIcon, ServerCogIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { CirceOrb } from "./CirceOrb";

export function SystemMap({
  deviceCount,
  agentCount,
  providerCount,
  devices,
  agents,
  providers,
}: {
  readonly deviceCount: number;
  readonly agentCount: number;
  readonly providerCount: number;
  readonly devices: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly online: boolean;
  }>;
  readonly agents: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly driver: ProviderDriverKind;
  }>;
  readonly providers: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly driver: ProviderDriverKind;
  }>;
}) {
  const columns = [
    {
      id: "devices",
      heading: `Devices (${deviceCount})`,
      icon: <MonitorSmartphoneIcon className="size-4 text-muted-foreground" />,
      count: deviceCount,
      chips: devices.map((device) => (
        <span
          className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
          key={device.id}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              device.online ? "bg-success" : "bg-muted-foreground/50",
            )}
          />
          <span className="truncate">{device.label}</span>
        </span>
      )),
    },
    {
      id: "agents",
      heading: `Agents (${agentCount})`,
      icon: <CirclePlayIcon className="size-4 text-muted-foreground" />,
      count: agentCount,
      chips: agents.map((agent) => {
        const Icon = PROVIDER_ICON_BY_PROVIDER[agent.driver] ?? BotIcon;
        return (
          <span
            className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
            key={agent.id}
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{agent.label}</span>
          </span>
        );
      }),
    },
    {
      id: "providers",
      heading: `Providers (${providerCount})`,
      icon: <ServerCogIcon className="size-4 text-muted-foreground" />,
      count: providerCount,
      chips: providers.map((provider) => {
        const Icon = PROVIDER_ICON_BY_PROVIDER[provider.driver] ?? ServerCogIcon;
        return (
          <span
            className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
            key={provider.id}
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{provider.label}</span>
          </span>
        );
      }),
    },
  ];
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-4">
      <span className="flex items-center gap-2 text-sm font-semibold tracking-[0.18em] text-foreground">
        <CirceOrb size={22} />
        CIRCE
      </span>
      <div aria-hidden className="hidden w-full flex-col items-center sm:flex">
        <span className="h-4 w-px bg-border" />
        <span className="relative block h-3 w-full">
          <span className="absolute inset-x-[16.666%] top-0 h-px bg-border" />
          <span className="absolute top-0 left-[16.666%] h-3 w-px bg-border" />
          <span className="absolute top-0 left-1/2 h-3 w-px bg-border" />
          <span className="absolute top-0 right-[16.666%] h-3 w-px bg-border" />
        </span>
      </div>
      <div className="grid w-full items-start gap-3 sm:grid-cols-3">
        {columns.map((column) => (
          <div className="flex min-w-0 flex-col items-center gap-2" key={column.id}>
            <span className="circe-section-label">{column.heading}</span>
            <div className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 py-2.5">
              {column.icon}
              <span className="text-xl font-semibold tabular-nums text-foreground">
                {column.count}
              </span>
            </div>
            {column.chips.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-1.5">{column.chips}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

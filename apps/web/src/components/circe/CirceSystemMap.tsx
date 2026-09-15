import type { ProviderDriverKind } from "@t3tools/contracts";
import { BotIcon, CirclePlayIcon, MonitorSmartphoneIcon, ServerCogIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { CirceOrb } from "./CirceOrb";

/** Keep the map a topology: the icon row folds the tail into a "+N" tile. */
const ENTITY_DISPLAY_LIMIT = 6;

type Entity = {
  readonly id: string;
  readonly label: string;
  readonly ready: boolean;
};

type ProviderEntity = Entity & { readonly driver: ProviderDriverKind };

/**
 * The topology view: one Circe identity, a trunk and bus, then a column per
 * category. Each column is a tile with a header, a count, and the entities it
 * contains, so the relationship reads as a graph rather than three counters.
 */
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
  readonly devices: ReadonlyArray<Entity>;
  readonly agents: ReadonlyArray<ProviderEntity>;
  readonly providers: ReadonlyArray<ProviderEntity>;
}) {
  const columns: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly count: number;
    readonly icon: ReactNode;
    readonly entities: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly ready: boolean;
      readonly icon: ReactNode;
    }>;
    readonly emptyLabel: string;
  }> = [
    {
      id: "devices",
      label: "Devices",
      count: deviceCount,
      icon: <MonitorSmartphoneIcon className="size-4" />,
      emptyLabel: "No devices",
      entities: devices.map((device) => ({
        id: device.id,
        label: device.label,
        ready: device.ready,
        icon: <MonitorSmartphoneIcon className="size-4" />,
      })),
    },
    {
      id: "agents",
      label: "Agents",
      count: agentCount,
      icon: <CirclePlayIcon className="size-4" />,
      emptyLabel: "No agents",
      entities: agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        ready: agent.ready,
        icon: (() => {
          const Icon = PROVIDER_ICON_BY_PROVIDER[agent.driver] ?? BotIcon;
          return <Icon className="size-4" />;
        })(),
      })),
    },
    {
      id: "providers",
      label: "Providers",
      count: providerCount,
      icon: <ServerCogIcon className="size-4" />,
      emptyLabel: "No providers",
      entities: providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        ready: provider.ready,
        icon: (() => {
          const Icon = PROVIDER_ICON_BY_PROVIDER[provider.driver] ?? ServerCogIcon;
          return <Icon className="size-4" />;
        })(),
      })),
    },
  ];

  return (
    <div className="flex flex-col items-center px-6 pt-7 pb-5">
      <div className="flex flex-col items-center gap-2.5">
        <CirceOrb size={52} />
        <span className="circe-brand-label text-foreground">Circe</span>
      </div>

      <div aria-hidden className="flex w-full flex-col items-center">
        <span className="h-6 w-px bg-border" />
        <span className="relative block h-6 w-full">
          <span className="absolute inset-x-[16.666%] top-0 h-px bg-border" />
          <span className="absolute top-0 left-[16.666%] h-6 w-px bg-border" />
          <span className="absolute top-0 left-1/2 h-6 w-px bg-border" />
          <span className="absolute top-0 right-[16.666%] h-6 w-px bg-border" />
        </span>
      </div>

      <div className="grid w-full items-start gap-4 sm:grid-cols-3">
        {columns.map((column) => (
          <section
            aria-label={column.label}
            className="flex min-w-0 flex-col self-start rounded-2xl border border-border bg-background/70 p-4"
            key={column.id}
          >
            <header className="flex flex-col gap-2.5">
              <span className="flex items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  {column.icon}
                </span>
                <span className="text-2xl leading-none font-semibold tabular-nums text-foreground">
                  {column.count}
                </span>
              </span>
              <span className="circe-section-label">{column.label}</span>
            </header>
            {column.entities.length === 0 ? (
              <p className="mt-3.5 text-xs text-muted-foreground">{column.emptyLabel}</p>
            ) : (
              <ul className="mt-3.5 flex flex-wrap gap-1.5">
                {column.entities.slice(0, ENTITY_DISPLAY_LIMIT).map((entity) => (
                  <li
                    className="relative grid size-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-card text-muted-foreground"
                    key={entity.id}
                    title={`${entity.label}${entity.ready ? "" : " · unavailable"}`}
                  >
                    {entity.icon}
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-card",
                        entity.ready ? "bg-success" : "bg-muted-foreground/45",
                      )}
                    />
                  </li>
                ))}
                {column.entities.length > ENTITY_DISPLAY_LIMIT ? (
                  <li className="grid size-8 shrink-0 place-items-center rounded-lg border border-dashed border-border text-[10px] text-muted-foreground">
                    +{column.entities.length - ENTITY_DISPLAY_LIMIT}
                  </li>
                ) : null}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

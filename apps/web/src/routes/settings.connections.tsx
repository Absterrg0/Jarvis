import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

type ConnectionsSettingsSearch = {
  readonly environmentId?: string;
  readonly action?: "rename" | "remove";
};

function parseConnectionsSettingsSearch(raw: Record<string, unknown>): ConnectionsSettingsSearch {
  return {
    ...(typeof raw.environmentId === "string" ? { environmentId: raw.environmentId } : {}),
    ...(raw.action === "rename" || raw.action === "remove" ? { action: raw.action } : {}),
  };
}

export const Route = createFileRoute("/settings/connections")({
  validateSearch: parseConnectionsSettingsSearch,
  component: ConnectionsSettings,
});

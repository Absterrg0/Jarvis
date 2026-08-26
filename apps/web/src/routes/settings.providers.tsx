import { EnvironmentId, type EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";

function SettingsProvidersRoute() {
  const { environmentId } = Route.useSearch();
  return (
    <ProviderSettingsPanel
      key={environmentId ?? "primary"}
      initialEnvironmentId={environmentId ?? null}
    />
  );
}

type ProviderSettingsSearch = { readonly environmentId?: EnvironmentIdType };

function parseProviderSettingsSearch(raw: Record<string, unknown>): ProviderSettingsSearch {
  if (typeof raw.environmentId !== "string") return {};
  try {
    return { environmentId: EnvironmentId.make(raw.environmentId) };
  } catch {
    return {};
  }
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: parseProviderSettingsSearch,
  component: SettingsProvidersRoute,
});

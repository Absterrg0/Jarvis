import { createFileRoute } from "@tanstack/react-router";

import { CommandsSettingsPanel } from "../components/settings/CommandsSettings";

function SettingsCommandsRoute() {
  return <CommandsSettingsPanel />;
}

export const Route = createFileRoute("/settings/commands")({
  component: SettingsCommandsRoute,
});

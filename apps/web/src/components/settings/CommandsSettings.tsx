import type { CustomCommand } from "@t3tools/contracts/settings";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type CommandDraft = {
  name: string;
  description: string;
  prompt: string;
};

const EMPTY_DRAFT: CommandDraft = { name: "", description: "", prompt: "" };

export function normalizeCustomCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "").replace(/\s+/g, "-").toLowerCase();
}

function commandValidationError(
  draft: CommandDraft,
  commands: ReadonlyArray<CustomCommand>,
  editingId: string | null,
): string | null {
  const name = normalizeCustomCommandName(draft.name);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(name)) {
    return "Use a command name with letters, numbers, hyphens, or underscores.";
  }
  if (draft.prompt.trim().length === 0) return "A workflow prompt is required.";
  if (commands.some((command) => command.id !== editingId && command.name === name)) {
    return `/${name} already exists.`;
  }
  return null;
}

export function CommandsSettingsPanel() {
  const commands = useClientSettings((settings) => settings.customCommands);
  const updateSettings = useUpdateClientSettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const enrichCustomCommand = useAtomCommand(serverEnvironment.enrichCustomCommand, {
    reportFailure: false,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommandDraft>(EMPTY_DRAFT);
  const [isSaving, setIsSaving] = useState(false);
  const validationError = useMemo(
    () => commandValidationError(draft, commands, editingId),
    [commands, draft, editingId],
  );

  const startCreate = () => {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
  };
  const startEdit = (command: CustomCommand) => {
    setEditingId(command.id);
    setDraft({
      name: command.name,
      description: command.description,
      prompt: command.prompt,
    });
  };
  const cancelEdit = () => {
    if (isSaving) return;
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };
  const save = async () => {
    if (!editingId || validationError) return;
    setIsSaving(true);
    const baseCommand: CustomCommand = {
      id: editingId === "new" ? randomUUID() : editingId,
      name: normalizeCustomCommandName(draft.name),
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
    };
    let command = baseCommand;
    if (primaryEnvironmentId) {
      try {
        const result = await enrichCustomCommand({
          environmentId: primaryEnvironmentId,
          input: {
            name: baseCommand.name,
            description: baseCommand.description,
            prompt: baseCommand.prompt,
          },
        });
        if (result._tag === "Success" && result.value.prompt.trim().length > 0) {
          command = {
            ...baseCommand,
            description: result.value.description.trim(),
            prompt: result.value.prompt.trim(),
          };
        } else if (result._tag === "Failure") {
          toastManager.add({
            type: "warning",
            title: "Workflow saved without enrichment",
            description: "The original prompt was kept because the text model was unavailable.",
          });
        }
      } catch {
        toastManager.add({
          type: "warning",
          title: "Workflow saved without enrichment",
          description: "The original prompt was kept because the text model was unavailable.",
        });
      }
    } else {
      toastManager.add({
        type: "warning",
        title: "Workflow saved without enrichment",
        description: "Connect to a server to use the low-effort text model.",
      });
    }
    updateSettings({
      customCommands:
        editingId === "new"
          ? [...commands, command]
          : commands.map((entry) => (entry.id === command.id ? command : entry)),
    });
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setIsSaving(false);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Custom commands"
        headerAction={
          editingId === null ? (
            <Button size="sm" onClick={startCreate}>
              <PlusIcon className="size-3.5" /> Add command
            </Button>
          ) : null
        }
      >
        <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
          Save repeatable workflows, then type <code>/</code> in the composer to find and insert
          them. On save, the selected low-effort text model tightens the description and prompt;
          your command name always stays unchanged. Commands are stored only on this device.
        </p>

        {editingId !== null ? (
          <div className="space-y-3 rounded-xl px-3 py-3 sm:px-4">
            <label className="grid gap-1.5 text-sm font-medium">
              Command name
              <Input
                autoFocus
                disabled={isSaving}
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="pr-cr"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
              <Input
                disabled={isSaving}
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="Review the current pull request"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Workflow prompt
              <Textarea
                disabled={isSaving}
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
                placeholder="Review the current pull request, fix verified findings, then summarize the result."
              />
            </label>
            {validationError ? <p className="text-sm text-destructive">{validationError}</p> : null}
            <div className="flex justify-end gap-2">
              <Button disabled={isSaving} variant="outline" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button disabled={validationError !== null || isSaving} onClick={() => void save()}>
                {isSaving ? "Enriching workflow…" : "Save command"}
              </Button>
            </div>
          </div>
        ) : null}

        {commands.length === 0 && editingId === null ? (
          <div className="rounded-xl px-3 py-8 text-center text-sm text-muted-foreground sm:px-4">
            No custom commands yet.
          </div>
        ) : null}

        {commands.map((command) => (
          <div key={command.id} className="flex items-start gap-3 rounded-xl px-3 py-3 sm:px-4">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm font-medium">/{command.name}</p>
              {command.description ? (
                <p className="mt-1 text-[13px] text-muted-foreground/80">{command.description}</p>
              ) : null}
              <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground/65">
                {command.prompt}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={() => startEdit(command)}>
                Edit
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete /${command.name}`}
                onClick={() =>
                  updateSettings({
                    customCommands: commands.filter((entry) => entry.id !== command.id),
                  })
                }
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  Settings2Icon,
} from "lucide-react";

import "./CirceNodeAgentSettings.css";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const NO_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("t3code_no_provider");
const NO_DEFAULT_SELECTION: ModelSelection = {
  instanceId: NO_DEFAULT_INSTANCE_ID,
  model: "",
};

type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "error"; readonly message: string };

function selectionStatus(
  selection: ModelSelection | null,
  entries: ReturnType<typeof deriveProviderInstanceEntries>,
): "none" | "valid" | "invalid" {
  if (selection === null) return "none";
  const entry = entries.find(
    (candidate) =>
      candidate.instanceId === selection.instanceId && isProviderInstancePickerReady(candidate),
  );
  if (!entry) return "invalid";
  // Validity is server-authoritative. UI model preferences can hide a live
  // model, while customModels can contain a slug the node has not advertised
  // yet; neither should change whether a saved node default is real.
  return entry.models.some((model) => model.slug === selection.model) ? "valid" : "invalid";
}

function modelSelectionsEqual(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null,
): boolean {
  if (left === null || left === undefined || right === null) {
    return (left === null || left === undefined) && right === null;
  }
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function CirceNodeAgentSettings({
  environmentId,
  online,
  executionEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly online: boolean;
  readonly executionEnabled: boolean;
}) {
  // Deliberately read the selected node. Do not use primary settings here:
  // this panel is rendered for every node in the Circe mesh.
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const session = useEnvironmentSessionState(environmentId);
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "circe node agent default",
    reportFailure: false,
  });
  const [draftSelection, setDraftSelection] = useState<ModelSelection | null>(
    () => config?.settings.circeDefaultModelSelection ?? null,
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const serverSelection = config?.settings.circeDefaultModelSelection ?? null;
  const serverSelectionKey = `${environmentId}:${JSON.stringify(serverSelection)}`;
  const serverSelectionKeyRef = useRef(serverSelectionKey);
  useEffect(() => {
    if (serverSelectionKeyRef.current === serverSelectionKey) return;
    serverSelectionKeyRef.current = serverSelectionKey;
    setDraftSelection(serverSelection);
    setSaveState((current) =>
      current.kind === "saving" || current.kind === "saved" ? current : { kind: "idle" },
    );
  }, [serverSelection, serverSelectionKey]);

  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const status = selectionStatus(draftSelection, entries);
  const readyEntries = useMemo(() => entries.filter(isProviderInstancePickerReady), [entries]);
  const pickerModelOptionsByInstance = useMemo(() => {
    if (status !== "valid" || draftSelection === null) return modelOptionsByInstance;
    const entry = entries.find((candidate) => candidate.instanceId === draftSelection.instanceId);
    const currentOptions = modelOptionsByInstance.get(draftSelection.instanceId) ?? [];
    const liveModel = entry?.models.find((model) => model.slug === draftSelection.model);
    if (!liveModel || currentOptions.some((model) => model.slug === draftSelection.model)) {
      return modelOptionsByInstance;
    }
    const selectedOption = {
      slug: liveModel.slug,
      name: liveModel.name,
      isCustom: liveModel.isCustom,
      ...(liveModel.shortName ? { shortName: liveModel.shortName } : {}),
      ...(liveModel.subProvider ? { subProvider: liveModel.subProvider } : {}),
    };
    return new Map(modelOptionsByInstance).set(draftSelection.instanceId, [
      ...currentOptions,
      selectedOption,
    ]);
  }, [draftSelection, entries, modelOptionsByInstance, status]);
  // A missing session during a transport error is unknown, not editable.
  // Older remote servers may omit scopes after an authenticated session; the
  // existing remote-settings policy treats that case as operable.
  const permissionsKnown = session.data !== null || (!session.isPending && !session.hasError);
  const hasWritePermission =
    session.data !== null &&
    session.data.authenticated &&
    (session.data.scopes === undefined || session.data.scopes.includes("orchestration:operate"));
  const canEdit =
    online && executionEnabled && config !== null && permissionsKnown && hasWritePermission;
  const canSave = canEdit && (draftSelection === null || status === "valid");
  const hasPendingChange = !modelSelectionsEqual(serverSelection, draftSelection);
  const showSave = config !== null && (readyEntries.length > 0 || hasPendingChange);
  const pickerSelection =
    status === "valid" && draftSelection !== null ? draftSelection : NO_DEFAULT_SELECTION;
  const activeEntry =
    entries.find((entry) => entry.instanceId === pickerSelection.instanceId) ?? null;

  const updateDraft = useCallback((selection: ModelSelection | null) => {
    setDraftSelection(selection);
    setSaveState({ kind: "idle" });
  }, []);

  const save = useCallback(async () => {
    if (!canSave || saveState.kind === "saving") return;
    setSaveState({ kind: "saving" });
    const result = await saveSettings({
      environmentId,
      input: { patch: { circeDefaultModelSelection: draftSelection } },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        setSaveState({ kind: "idle" });
        return;
      }
      const error = squashAtomCommandFailure(result);
      setSaveState({
        kind: "error",
        message: error instanceof Error ? error.message : "The device rejected this default.",
      });
      return;
    }
    if (!modelSelectionsEqual(result.value.circeDefaultModelSelection, draftSelection)) {
      setSaveState({
        kind: "error",
        message: "Update Circe on this device to save its default agent.",
      });
      return;
    }
    setSaveState({ kind: "saved" });
  }, [canSave, draftSelection, environmentId, saveSettings, saveState.kind]);

  const reset = useCallback(() => updateDraft(null), [updateDraft]);

  // Live voice drafts stay uncontrolled and remount from the server echo via
  // `key`, so an edit never races another device's save.
  const liveVoice = config?.settings.circeLiveVoice;
  const liveVoiceKeyConfigured = (liveVoice?.apiKey.length ?? 0) > 0;
  const liveVoiceModelRef = useRef<HTMLInputElement>(null);
  const liveVoiceNameRef = useRef<HTMLInputElement>(null);
  const liveVoiceKeyRef = useRef<HTMLInputElement>(null);
  const [liveVoiceSaveState, setLiveVoiceSaveState] = useState<SaveState>({ kind: "idle" });
  const canEditLiveVoice = online && config !== null && permissionsKnown && hasWritePermission;

  const applyLiveVoiceResult = useCallback(
    async (operation: "save" | "clear"): Promise<void> => {
      if (!canEditLiveVoice || liveVoiceSaveState.kind === "saving") return;
      setLiveVoiceSaveState({ kind: "saving" });
      const model = liveVoiceModelRef.current?.value.trim() ?? "";
      const voice = liveVoiceNameRef.current?.value.trim() ?? "";
      const apiKey = liveVoiceKeyRef.current?.value.trim() ?? "";
      const result = await saveSettings({
        environmentId,
        input: {
          patch: {
            circeLiveVoice:
              operation === "clear"
                ? { apiKey: "" }
                : {
                    ...(model.length > 0 ? { model } : {}),
                    ...(voice.length > 0 ? { voice } : {}),
                    ...(apiKey.length > 0 ? { apiKey } : {}),
                  },
          },
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          setLiveVoiceSaveState({ kind: "idle" });
          return;
        }
        const error = squashAtomCommandFailure(result);
        setLiveVoiceSaveState({
          kind: "error",
          message: error instanceof Error ? error.message : "The device rejected this change.",
        });
        return;
      }
      if (liveVoiceKeyRef.current !== null) liveVoiceKeyRef.current.value = "";
      setLiveVoiceSaveState({ kind: "saved" });
    },
    [canEditLiveVoice, environmentId, liveVoiceSaveState.kind, saveSettings],
  );

  const statusMessage =
    config === null
      ? "Waiting for this device's configuration."
      : !online
        ? "This device is offline."
        : !executionEnabled
          ? "Controller nodes cannot execute new tasks."
          : !permissionsKnown
            ? "Checking this session's permissions."
            : !hasWritePermission
              ? "This session can view the device but cannot change its settings."
              : status === "none"
                ? serverSelection !== null
                  ? "Project defaults selected. Save to apply."
                  : "No default is saved. Choose a provider and model, then save it."
                : status === "invalid"
                  ? `Saved default ${draftSelection?.instanceId ?? "unknown"} / ${draftSelection?.model ?? "unknown"} is unavailable from this device's live provider catalog.`
                  : null;

  return (
    <details className="circe-node-settings">
      <summary className="circe-node-settings__summary">
        <span className="circe-node-settings__icon">
          <Settings2Icon className="size-4" />
        </span>
        <span className="circe-node-settings__heading">
          <span>Node settings</span>
          <span className="circe-node-settings__description">
            Default agent, semantic supervisor, live voice
          </span>
        </span>
        <ChevronDownIcon className="circe-node-settings__chevron size-4" />
      </summary>
      <div className="circe-node-settings__body">
        <section className="min-w-0" aria-label="Circe agent defaults">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">Default agent for new tasks</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                Saved on this device. Spoken choices override this default; existing tasks keep
                their agent.
              </p>
            </div>
            {statusMessage ? (
              <p
                className={cn(
                  "max-w-sm text-right text-[11px] leading-relaxed",
                  status === "invalid" || !canEdit ? "text-amber-500" : "text-muted-foreground",
                )}
              >
                {statusMessage}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-y border-border/55 py-3">
            {config !== null ? (
              <>
                {readyEntries.length > 0 && (status === "none" || status === "invalid") ? (
                  <span className="mr-auto text-xs text-muted-foreground">
                    {status === "none" ? "No default set" : "Saved default unavailable"}
                  </span>
                ) : null}
                {readyEntries.length > 0 ? (
                  <>
                    <ProviderModelPicker
                      activeInstanceId={pickerSelection.instanceId}
                      model={pickerSelection.model}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={pickerModelOptionsByInstance}
                      triggerVariant="outline"
                      triggerClassName="min-w-44 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      triggerAriaLabel="Choose default Circe provider and model"
                      disabled={!canEdit || saveState.kind === "saving"}
                      onInstanceModelChange={(instanceId, model) =>
                        updateDraft(createModelSelection(instanceId, model))
                      }
                    />
                    {activeEntry && status === "valid" ? (
                      <span
                        className={
                          !canEdit || saveState.kind === "saving"
                            ? "pointer-events-none opacity-60"
                            : undefined
                        }
                        inert={!canEdit || saveState.kind === "saving" || undefined}
                        aria-disabled={!canEdit || saveState.kind === "saving" || undefined}
                      >
                        <TraitsPicker
                          provider={activeEntry.driverKind}
                          instanceId={activeEntry.instanceId}
                          models={activeEntry.models}
                          model={pickerSelection.model}
                          prompt=""
                          onPromptChange={() => {}}
                          modelOptions={pickerSelection.options ?? []}
                          allowPromptInjectedEffort={false}
                          planModeEnabled={settings.planModeEnabled}
                          triggerVariant="outline"
                          triggerClassName="min-w-24 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                          onModelOptionsChange={(options) =>
                            updateDraft(
                              createModelSelection(
                                pickerSelection.instanceId,
                                pickerSelection.model,
                                options,
                              ),
                            )
                          }
                        />
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="mr-auto text-xs text-muted-foreground">
                    No ready providers on this device.
                  </span>
                )}
                {showSave ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canSave || saveState.kind === "saving"}
                    onClick={() => void save()}
                  >
                    {saveState.kind === "saving" ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : null}
                    Save
                  </Button>
                ) : null}
                {draftSelection !== null ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!canEdit || saveState.kind === "saving"}
                    onClick={reset}
                  >
                    Use project defaults
                  </Button>
                ) : null}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                {config === null
                  ? "Provider choices are unavailable until the device connects."
                  : "No ready providers on this device."}
              </span>
            )}
          </div>

          {saveState.kind === "saved" ? (
            <p
              className="mt-2 flex items-center justify-end gap-1 text-[11px] text-emerald-500"
              role="status"
            >
              <CheckIcon className="size-3" /> Default saved on this device.
            </p>
          ) : saveState.kind === "error" ? (
            <p
              className="mt-2 flex items-center justify-end gap-1 text-[11px] text-destructive"
              role="alert"
            >
              <AlertCircleIcon className="size-3" /> {saveState.message}
            </p>
          ) : null}
        </section>

        <section className="mt-8 min-w-0" aria-label="Circe semantic supervisor">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">Semantic supervisor</h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Circe validates your request before starting work. The supervisor follows the agent
              selected for the task. Set the default agent above to choose what new tasks use.
            </p>
          </div>
        </section>

        <section className="mt-8 min-w-0" aria-label="Circe live voice">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">Live conversation</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                Full-duplex speech with GPT-Live on this device. The OpenAI API key stays on this
                device; browsers and phones only ask it to start a session.
              </p>
            </div>
            {!canEditLiveVoice ? (
              <p className="max-w-sm text-right text-[11px] leading-relaxed text-amber-500">
                {config === null
                  ? "Waiting for this device's configuration."
                  : !online
                    ? "This device is offline."
                    : "This session can view the device but cannot change its settings."}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-y border-border/55 py-3">
            <Input
              key={`live-model-${liveVoice?.model ?? ""}`}
              ref={liveVoiceModelRef}
              aria-label="Live voice model"
              placeholder="gpt-live-1"
              defaultValue={liveVoice?.model ?? ""}
              disabled={!canEditLiveVoice || liveVoiceSaveState.kind === "saving"}
              className="w-40"
            />
            <Input
              key={`live-voice-name-${liveVoice?.voice ?? ""}`}
              ref={liveVoiceNameRef}
              aria-label="Live voice"
              placeholder="marin"
              defaultValue={liveVoice?.voice ?? ""}
              disabled={!canEditLiveVoice || liveVoiceSaveState.kind === "saving"}
              className="w-32"
            />
            <Input
              ref={liveVoiceKeyRef}
              type="password"
              aria-label="OpenAI API key"
              placeholder={liveVoiceKeyConfigured ? "API key configured" : "OpenAI API key"}
              disabled={!canEditLiveVoice || liveVoiceSaveState.kind === "saving"}
              className="min-w-48 flex-1"
            />
            <Button
              size="xs"
              variant="outline"
              disabled={!canEditLiveVoice || liveVoiceSaveState.kind === "saving"}
              onClick={() => void applyLiveVoiceResult("save")}
            >
              {liveVoiceSaveState.kind === "saving" ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : null}
              Save
            </Button>
            {liveVoiceKeyConfigured ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={!canEditLiveVoice || liveVoiceSaveState.kind === "saving"}
                onClick={() => void applyLiveVoiceResult("clear")}
              >
                Remove key
              </Button>
            ) : null}
          </div>
          {liveVoiceSaveState.kind === "saved" ? (
            <p
              className="mt-2 flex items-center justify-end gap-1 text-[11px] text-emerald-500"
              role="status"
            >
              <CheckIcon className="size-3" /> Live voice settings saved on this device.
            </p>
          ) : liveVoiceSaveState.kind === "error" ? (
            <p
              className="mt-2 flex items-center justify-end gap-1 text-[11px] text-destructive"
              role="alert"
            >
              <AlertCircleIcon className="size-3" /> {liveVoiceSaveState.message}
            </p>
          ) : null}
        </section>
      </div>
    </details>
  );
}

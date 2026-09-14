import { useAtomValue } from "@effect/atom-react";
import { ProviderInstanceId, type DesktopCirceOrbSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { circeMeshCatalogAtom } from "../../state/circeMesh";
import { useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildDesktopCirceOrbCatalog,
  buildDesktopCirceOrbAgents,
  isDesktopCirceOrbSelectionValid,
} from "./CirceDesktopOrb.bridge";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Headless reporter behind the desktop orb. No visual UI here: the orb lives
 * in the main-process overlay. This bridge pushes the owning node's real
 * provider catalog to main and saves orb picker selections through the
 * ordinary node settings API (`circeDefaultModelSelection`). Pending and
 * failure states flow back into the catalog so the orb stays honest.
 */
export function CirceDesktopOrbReporter({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const catalog = useAtomValue(circeMeshCatalogAtom);
  const threads = useThreadShells();
  const agents = useMemo(() => buildDesktopCirceOrbAgents(threads, catalog), [threads, catalog]);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "circe orb default",
    reportFailure: false,
  });
  const [pendingSelection, setPendingSelection] = useState<DesktopCirceOrbSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);

  const serverSelection = useMemo<DesktopCirceOrbSelection | null>(() => {
    const saved = config?.settings.circeDefaultModelSelection ?? null;
    if (saved === null) return null;
    return { instanceId: saved.instanceId, model: saved.model };
  }, [config]);

  // With no saved default, show the provider the Director will actually pick
  // (first available on this node) so the panel never looks unpicked.
  const fallbackSelection = useMemo<DesktopCirceOrbSelection | null>(() => {
    for (const provider of catalog?.providers ?? []) {
      if (provider.nodeId !== environmentId || !provider.available) continue;
      const models = provider.snapshot.models ?? [];
      const model = models.find((candidate) => candidate.isDefault === true) ?? models[0];
      if (model === undefined || typeof model.slug !== "string" || model.slug.length === 0)
        continue;
      return { instanceId: provider.snapshot.instanceId, model: model.slug };
    }
    return null;
  }, [catalog, environmentId]);
  const effectiveSelection = serverSelection ?? fallbackSelection;

  const orbCatalog = useMemo(
    () =>
      buildDesktopCirceOrbCatalog({
        providers: catalog?.providers ?? [],
        nodeId: environmentId,
        selected: effectiveSelection,
        pendingSelection,
        error,
        agents,
      }),
    [catalog, environmentId, effectiveSelection, pendingSelection, error, agents],
  );

  // Push the real catalog whenever it changes. Fire-and-forget: the orb
  // renders the latest it got, and the next push corrects a dropped one.
  useEffect(() => {
    window.desktopBridge?.circeOrb?.reportCatalog(orbCatalog);
  }, [orbCatalog]);

  // A server echo clears a finished save. When another device changes the
  // default under us, drop our pending row and surface the new truth.
  const serverSelectionKey = JSON.stringify(serverSelection);
  const serverSelectionKeyRef = useRef(serverSelectionKey);
  useEffect(() => {
    if (serverSelectionKeyRef.current === serverSelectionKey) return;
    serverSelectionKeyRef.current = serverSelectionKey;
    pendingRef.current = false;
    setPendingSelection(null);
  }, [serverSelectionKey]);

  const handleSelect = useCallback(
    async (selection: DesktopCirceOrbSelection) => {
      if (pendingRef.current) return;
      // Validate against the catalog the orb rendered from. Unknown ids mean
      // a stale picker; report honestly instead of saving fiction.
      if (!isDesktopCirceOrbSelectionValid(selection, orbCatalog)) {
        setError("That provider is no longer available on this device.");
        return;
      }
      pendingRef.current = true;
      setPendingSelection(selection);
      setError(null);
      const result = await saveSettings({
        environmentId,
        input: {
          patch: {
            circeDefaultModelSelection: createModelSelection(
              ProviderInstanceId.make(selection.instanceId),
              selection.model,
            ),
          },
        },
      });
      pendingRef.current = false;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          setPendingSelection(null);
          return;
        }
        const failure = squashAtomCommandFailure(result);
        setPendingSelection(null);
        setError(failure instanceof Error ? failure.message : "The device rejected this default.");
        return;
      }
      const echoed = result.value.circeDefaultModelSelection;
      if (
        echoed === null ||
        echoed === undefined ||
        echoed.instanceId !== selection.instanceId ||
        echoed.model !== selection.model
      ) {
        setPendingSelection(null);
        setError("Update Circe on this device to save its default agent.");
        return;
      }
      setPendingSelection(null);
      setError(null);
    },
    [environmentId, orbCatalog, saveSettings],
  );

  const handleSelectRef = useRef(handleSelect);
  useEffect(() => {
    handleSelectRef.current = handleSelect;
  }, [handleSelect]);

  useEffect(() => {
    const subscribe = window.desktopBridge?.circeOrb?.onSelect;
    if (typeof subscribe !== "function") return;
    return subscribe((selection) => {
      void handleSelectRef.current(selection);
    });
  }, []);

  return null;
}

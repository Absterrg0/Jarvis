import { useAtomValue } from "@effect/atom-react";
import { ProviderInstanceId, type DesktopJarvisOrbSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { jarvisMeshCatalogAtom } from "../../state/jarvisMesh";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildDesktopJarvisOrbCatalog,
  isDesktopJarvisOrbSelectionValid,
} from "./JarvisDesktopOrb.bridge";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Headless reporter behind the desktop orb. No visual UI here: the orb lives
 * in the main-process overlay. This bridge pushes the owning node's real
 * provider catalog to main and saves orb picker selections through the
 * ordinary node settings API (`jarvisDefaultModelSelection`). Pending and
 * failure states flow back into the catalog so the orb stays honest.
 */
export function JarvisDesktopOrbReporter({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const catalog = useAtomValue(jarvisMeshCatalogAtom);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "jarvis orb default",
    reportFailure: false,
  });
  const [pendingSelection, setPendingSelection] = useState<DesktopJarvisOrbSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);

  const serverSelection = useMemo<DesktopJarvisOrbSelection | null>(() => {
    const saved = config?.settings.jarvisDefaultModelSelection ?? null;
    if (saved === null) return null;
    return { instanceId: saved.instanceId, model: saved.model };
  }, [config]);

  const orbCatalog = useMemo(
    () =>
      buildDesktopJarvisOrbCatalog({
        providers: catalog?.providers ?? [],
        nodeId: environmentId,
        selected: serverSelection,
        pendingSelection,
        error,
      }),
    [catalog, environmentId, serverSelection, pendingSelection, error],
  );

  // Push the real catalog whenever it changes. Fire-and-forget: the orb
  // renders the latest it got, and the next push corrects a dropped one.
  useEffect(() => {
    window.desktopBridge?.jarvisOrb?.reportCatalog(orbCatalog);
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
    async (selection: DesktopJarvisOrbSelection) => {
      if (pendingRef.current) return;
      // Validate against the catalog the orb rendered from. Unknown ids mean
      // a stale picker; report honestly instead of saving fiction.
      if (!isDesktopJarvisOrbSelectionValid(selection, orbCatalog)) {
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
            jarvisDefaultModelSelection: createModelSelection(
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
      const echoed = result.value.jarvisDefaultModelSelection;
      if (
        echoed === null ||
        echoed === undefined ||
        echoed.instanceId !== selection.instanceId ||
        echoed.model !== selection.model
      ) {
        setPendingSelection(null);
        setError("Update ARIS on this device to save its default agent.");
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
    const subscribe = window.desktopBridge?.jarvisOrb?.onSelect;
    if (typeof subscribe !== "function") return;
    return subscribe((selection) => {
      void handleSelectRef.current(selection);
    });
  }, []);

  return null;
}

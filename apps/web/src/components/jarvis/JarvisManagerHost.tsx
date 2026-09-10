import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { type JarvisCommandTarget, onOpenJarvis } from "../../jarvisBus";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThread } from "../../state/entities";
import type { AppRouter } from "../../router";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import {
  isJarvisShortcut,
  isJarvisLocalVoiceRoute,
  resolveJarvisDesktopMenuAction,
  shouldHandleJarvisShortcutInRenderer,
} from "./JarvisManager.logic";
import { createJarvisDesktopVoiceActionController } from "./JarvisNativeCapture";
import { JarvisVoiceReporter } from "./JarvisVoiceReporter";

const JarvisVoiceRuntime = lazy(async () => {
  const module = await import("./JarvisVoiceRuntime");
  return { default: module.JarvisVoiceRuntime };
});

export function JarvisManagerHost({ router }: { readonly router: AppRouter }) {
  const routeTarget = useRouterState({
    router,
    select: (state) =>
      resolveThreadRouteTarget(state.matches[state.matches.length - 1]?.params ?? {}),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const activeDraftThread = useComposerDraftStore((store) => {
    if (!routeTarget) return null;
    return routeTarget.kind === "server"
      ? store.getDraftThread(routeTarget.threadRef)
      : store.getDraftSession(routeTarget.draftId);
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const jarvisSurfaceOpen = useRouterState({
    router,
    select: (state) => {
      const pathname =
        (state as unknown as { location?: { pathname?: string } }).location?.pathname ?? "";
      return pathname === "/jarvis" || pathname.startsWith("/jarvis/");
    },
  });
  // Once the browser Jarvis surface opens, its runtime stays mounted until
  // the host unmounts so an explicit target survives navigation and remounts.
  const [browserRuntimeLatched, setBrowserRuntimeLatched] = useState(false);
  useEffect(() => {
    if (jarvisSurfaceOpen) setBrowserRuntimeLatched(true);
  }, [jarvisSurfaceOpen]);

  // One-time cleanup: reports used to persist an attention target that stole
  // command focus after reload. That path is gone; drop the stale key.
  useEffect(() => {
    try {
      localStorage.removeItem("t3code:jarvis:attention-target:v1");
    } catch {
      // Blocked storage must not break the control center.
    }
  }, []);

  useEffect(() => {
    if (!shouldHandleJarvisShortcutInRenderer(isElectron)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isJarvisShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void router.navigate({ to: "/jarvis" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  useEffect(
    () =>
      onOpenJarvis(() => {
        void router.navigate({ to: "/jarvis" });
      }),
    [router],
  );

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    const voice = window.desktopBridge?.jarvisVoice;
    const voiceActions =
      voice === undefined
        ? null
        : createJarvisDesktopVoiceActionController({
            voice,
            onStartFailure: () => undefined,
            onReleaseFailure: () => undefined,
          });
    const removeMenuActionListener = onMenuAction((action) => {
      const resolvedAction = resolveJarvisDesktopMenuAction(action);
      switch (resolvedAction) {
        case "open-control-center":
          void router.navigate({ to: "/jarvis" });
          break;
        case "voice-toggle":
        case "voice-start":
        case "voice-release":
          voiceActions?.handle(resolvedAction);
          break;
        case null:
          break;
      }
    });
    const removeVoiceStateListener = voice?.onState((state) => {
      if (
        state.status === "ready" ||
        state.status === "capturing" ||
        state.status === "error" ||
        state.status === "unavailable"
      ) {
        voiceActions?.syncWorkerState(state.status);
      }
    });
    return () => {
      removeMenuActionListener();
      removeVoiceStateListener?.();
      voiceActions?.dispose();
    };
  }, [router]);

  const routeCommandTarget: JarvisCommandTarget | null =
    activeThread !== null &&
    isJarvisLocalVoiceRoute(primaryEnvironmentId, activeThread.environmentId)
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeThread.projectId,
          contextThreadId: activeThread.id,
          contextThreadTitle: activeThread.title,
        }
      : activeDraftThread !== null &&
          isJarvisLocalVoiceRoute(primaryEnvironmentId, activeDraftThread.environmentId)
        ? {
            environmentId: activeDraftThread.environmentId,
            projectId: activeDraftThread.projectId,
          }
        : null;
  const handleThreadStarted = useCallback(
    async (environmentId: EnvironmentId, threadId: ThreadId) => {
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    },
    [router],
  );
  // Native voice stays mounted on desktop. Browser mounts lazily when the
  // Jarvis surface first opens, then stays latched for the host lifetime.
  const shouldMountRuntime = isElectron || jarvisSurfaceOpen || browserRuntimeLatched;

  return (
    <>
      <JarvisVoiceReporter />
      {shouldMountRuntime ? (
        <Suspense fallback={null}>
          <JarvisVoiceRuntime
            routeTarget={routeCommandTarget}
            onTargetConsumed={() => undefined}
            onThreadStarted={handleThreadStarted}
          />
        </Suspense>
      ) : null}
    </>
  );
}

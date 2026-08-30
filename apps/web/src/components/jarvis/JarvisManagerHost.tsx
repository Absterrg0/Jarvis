import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import {
  type JarvisAttentionTarget,
  type JarvisCommandTarget,
  clearJarvisAttentionTarget,
  onJarvisAttentionTarget,
  onOpenJarvis,
  onOpenJarvisOnboarding,
  readJarvisAttentionTarget,
} from "../../jarvisBus";
import { primaryServerConfigAtom } from "../../state/server";
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
import { canAutoOpenJarvisOnboarding } from "./JarvisOnboarding.logic";
import { JarvisOnboarding, shouldShowJarvisOnboarding } from "./JarvisOnboarding";

const JarvisManagerDialog = lazy(async () => {
  const module = await import("./JarvisManagerDialog");
  return { default: module.JarvisManagerDialog };
});

export function JarvisManagerHost({
  router,
  companionMode = false,
}: {
  readonly router: AppRouter;
  readonly companionMode?: boolean;
}) {
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
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [attentionTarget, setAttentionTarget] = useState<JarvisAttentionTarget | null>(
    readJarvisAttentionTarget,
  );
  const onboardingAutoOpenAttemptedRef = useRef(false);
  const voiceReturnFocusRef = useRef<HTMLElement | null>(null);

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
    if (companionMode) return;
    return onOpenJarvisOnboarding(() => {
      setOnboardingOpen(true);
    });
  }, [companionMode]);
  useEffect(() => {
    if (
      !canAutoOpenJarvisOnboarding({
        companionMode,
        environmentReady: primaryEnvironmentId !== null,
        attentionTargetPresent: attentionTarget !== null,
        attemptMade: onboardingAutoOpenAttemptedRef.current,
        completionStored: !shouldShowJarvisOnboarding({
          environmentId: primaryEnvironmentId,
          preset: primaryServerConfig?.environment.capabilities.jarvisNode?.preset ?? "full",
        }),
      })
    )
      return;
    onboardingAutoOpenAttemptedRef.current = true;
    const frame = window.requestAnimationFrame(() => setOnboardingOpen(true));
    return () => window.cancelAnimationFrame(frame);
  }, [attentionTarget, companionMode, primaryEnvironmentId, primaryServerConfig]);
  useEffect(
    () =>
      onJarvisAttentionTarget((target) => {
        setAttentionTarget(target);
        setOnboardingOpen(false);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
        });
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

  const handleOpenConnections = useCallback(
    (environmentId?: EnvironmentId, action?: "rename" | "remove") => {
      if (environmentId === undefined) {
        void router.navigate({ to: "/settings/connections" });
        return;
      }
      void router.navigate({
        to: "/settings/connections",
        search: {
          environmentId,
          ...(action === undefined ? {} : { action }),
        },
      });
    },
    [router],
  );
  const handleOpenProviderSettings = useCallback(() => {
    setOnboardingOpen(false);
    void router.navigate({ to: "/settings/providers" });
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

  return (
    <>
      <JarvisVoiceReporter />
      {!companionMode && isElectron ? (
        <Suspense fallback={null}>
          <JarvisManagerDialog
            voiceOnly
            autoSubmitVoice
            open
            onOpenChange={() => undefined}
            returnFocusRef={voiceReturnFocusRef}
            attentionTarget={attentionTarget}
            routeTarget={routeCommandTarget}
            onTargetConsumed={() => {
              clearJarvisAttentionTarget();
              setAttentionTarget(null);
            }}
            onThreadStarted={handleThreadStarted}
            onOpenConnections={handleOpenConnections}
            onOpenOnboarding={() => setOnboardingOpen(true)}
          />
        </Suspense>
      ) : null}
      {!companionMode ? (
        <JarvisOnboarding
          open={onboardingOpen}
          onOpenChange={setOnboardingOpen}
          onOpenConnections={(environmentId, action) => {
            setOnboardingOpen(false);
            handleOpenConnections(environmentId, action);
          }}
          onOpenProviderSettings={handleOpenProviderSettings}
        />
      ) : null}
    </>
  );
}

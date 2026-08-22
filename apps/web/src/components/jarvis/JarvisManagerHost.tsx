import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  type JarvisAttentionTarget,
  type JarvisCommandTarget,
  clearJarvisAttentionTarget,
  onJarvisAttentionTarget,
  onOpenJarvis,
  onOpenJarvisOnboarding,
  readJarvisAttentionTarget,
} from "../../jarvisBus";
import { useThread } from "../../state/entities";
import { setPreferredJarvisSpeaker } from "../../jarvisPreferences";
import type { AppRouter } from "../../router";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { isJarvisShortcut } from "./JarvisManager.logic";
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
  const [open, setOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [attentionTarget, setAttentionTarget] = useState<JarvisAttentionTarget | null>(
    readJarvisAttentionTarget,
  );
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onboardingAutoOpenAttemptedRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isJarvisShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => onOpenJarvis(() => setOpen(true)), []);
  useEffect(() => {
    if (companionMode) return;
    return onOpenJarvisOnboarding(() => {
      setOpen(false);
      setOnboardingOpen(true);
    });
  }, [companionMode]);
  useEffect(() => {
    if (
      !canAutoOpenJarvisOnboarding({
        companionMode,
        attentionTargetPresent: attentionTarget !== null,
        attemptMade: onboardingAutoOpenAttemptedRef.current,
        completionStored: !shouldShowJarvisOnboarding(),
      })
    )
      return;
    onboardingAutoOpenAttemptedRef.current = true;
    const frame = window.requestAnimationFrame(() => setOnboardingOpen(true));
    return () => window.cancelAnimationFrame(frame);
  }, [attentionTarget, companionMode]);
  useEffect(
    () =>
      onJarvisAttentionTarget((target) => {
        setAttentionTarget(target);
        setOnboardingOpen(false);
        setOpen(true);
      }),
    [],
  );

  useEffect(() => {
    if (!companionMode) return;
    setPreferredJarvisSpeaker(true);
  }, [companionMode]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    return onMenuAction((action) => {
      if (action === "jarvis.toggle") setOpen((current) => !current);
    });
  }, []);

  const routeCommandTarget: JarvisCommandTarget | null = activeThread
    ? {
        environmentId: activeThread.environmentId,
        projectId: activeThread.projectId,
        contextThreadId: activeThread.id,
        contextThreadTitle: activeThread.title,
      }
    : activeDraftThread
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
  const handleOpenConnections = useCallback(
    (environmentId?: EnvironmentId, action?: "rename" | "remove") => {
      setOpen(false);
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

  return (
    <>
      <JarvisVoiceReporter />
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
      {open ? (
        <Suspense fallback={null}>
          <JarvisManagerDialog
            companionMode={companionMode}
            open={open}
            onOpenChange={setOpen}
            returnFocusRef={previousFocusRef}
            attentionTarget={attentionTarget}
            routeTarget={routeCommandTarget}
            onTargetConsumed={() => {
              clearJarvisAttentionTarget();
              setAttentionTarget(null);
            }}
            onThreadStarted={handleThreadStarted}
            onOpenConnections={handleOpenConnections}
            onOpenOnboarding={() => {
              setOpen(false);
              setOnboardingOpen(true);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}

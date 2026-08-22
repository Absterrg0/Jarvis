import {
  jarvisNodeCapabilitiesForPreset,
  type JarvisNodeCapabilities,
  type ServerConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  FolderGit2Icon,
  NetworkIcon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JarvisMeshCatalog } from "@t3tools/client-runtime/jarvis/mesh";
import { openCommandPalette } from "../../commandPaletteBus";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import {
  classifyJarvisOnboardingProvider,
  jarvisConnectionRouteLabel,
  jarvisNodeCapabilitySummary,
  jarvisNodePresetLabel,
  jarvisOnboardingProviderStatusLabel,
  jarvisOnboardingReadiness,
  jarvisOnboardingNextStep,
  jarvisOnboardingPreviousStep,
  jarvisOnboardingStepIndex,
  jarvisOnboardingSteps,
  jarvisRefreshRequestIsCurrent,
  jarvisTailscaleStatus,
  validateJarvisNodeLabel,
  type JarvisOnboardingStepId,
  readJarvisOnboardingCompletion,
  writeJarvisOnboardingCompletion,
} from "./JarvisOnboarding.logic";

export interface JarvisOnboardingProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenConnections: (environmentId?: EnvironmentId, action?: "rename" | "remove") => void;
  readonly onOpenProviderSettings: () => void;
}

function capabilityForPrimaryNode(config: ServerConfig | null): JarvisNodeCapabilities {
  return config?.environment.capabilities.jarvisNode ?? jarvisNodeCapabilitiesForPreset("full");
}

function providerStatusClass(status: ReturnType<typeof classifyJarvisOnboardingProvider>): string {
  switch (status) {
    case "ready":
      return "text-success";
    case "sign-in":
      return "text-warning-foreground";
    case "not-installed":
      return "text-muted-foreground";
    case "attention":
      return "text-destructive-foreground";
  }
}

export function JarvisOnboarding({
  open,
  onOpenChange,
  onOpenConnections,
  onOpenProviderSettings,
}: JarvisOnboardingProps) {
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const capabilities = capabilityForPrimaryNode(primaryServerConfig);
  const desktopNetworkAccess = useEnvironmentQuery(
    typeof window !== "undefined" && window.desktopBridge !== undefined
      ? desktopNetworkAccessStateAtom
      : null,
  );
  const refreshMesh = useAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const setEnvironmentLabel = useAtomCommand(serverEnvironment.setEnvironmentLabel, {
    reportFailure: false,
    reportDefect: false,
  });
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<JarvisOnboardingStepId>("device");
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [labelSaving, setLabelSaving] = useState(false);
  const refreshRequestIdRef = useRef(0);

  const dismiss = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const refreshCatalog = useCallback(() => {
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    setPending(true);
    setError(null);
    void refreshMesh(undefined).then((result) => {
      if (
        !jarvisRefreshRequestIsCurrent({
          requestId,
          latestRequestId: refreshRequestIdRef.current,
        })
      )
        return;
      setPending(false);
      if (result._tag === "Failure") {
        setError("Could not refresh the Jarvis node.");
        return;
      }
      setCatalog(result.value);
    });
  }, [refreshMesh]);

  useEffect(() => {
    if (!open) return;
    setActiveStep("device");
    refreshCatalog();
    return () => {
      refreshRequestIdRef.current += 1;
    };
  }, [open, refreshCatalog]);

  const currentLabel =
    primaryServerConfig?.environment.label ?? primaryEnvironment?.entry.target.label ?? "";
  const labelValue = labelDraft ?? currentLabel;
  const saveLabel = useCallback(async (): Promise<boolean> => {
    if (primaryEnvironmentId === null) return false;
    const validation = validateJarvisNodeLabel(labelValue);
    if (!validation.valid) {
      setLabelError(validation.message);
      return false;
    }
    setLabelError(null);
    setLabelSaving(true);
    try {
      const result = await setEnvironmentLabel({
        environmentId: primaryEnvironmentId,
        input: { label: validation.value },
      });
      if (result._tag === "Failure") {
        setLabelError("Could not save the device name.");
        return false;
      }
      setLabelDraft(result.value.label);
      refreshCatalog();
      return true;
    } catch {
      setLabelError("Could not save the device name.");
      return false;
    } finally {
      setLabelSaving(false);
    }
  }, [labelValue, primaryEnvironmentId, refreshCatalog, setEnvironmentLabel]);

  const primaryNode = catalog?.nodes.find((node) => node.nodeId === primaryEnvironmentId) ?? null;
  const primaryProviders = useMemo(
    () => catalog?.providers.filter((provider) => provider.nodeId === primaryEnvironmentId) ?? [],
    [catalog?.providers, primaryEnvironmentId],
  );
  const primaryProjects = useMemo(
    () => catalog?.projects.filter((project) => project.ref.nodeId === primaryEnvironmentId) ?? [],
    [catalog?.projects, primaryEnvironmentId],
  );
  const connectionRoute = primaryEnvironment
    ? jarvisConnectionRouteLabel({
        targetTag: primaryEnvironment.entry.target._tag,
        displayUrl: primaryEnvironment.displayUrl,
        ...(desktopNetworkAccess.data
          ? { advertisedEndpoints: desktopNetworkAccess.data.advertisedEndpoints }
          : {}),
      })
    : "Connection pending";
  const tailscaleStatus = primaryEnvironment
    ? jarvisTailscaleStatus({
        connectionPhase: primaryEnvironment.connection.phase,
        targetTag: primaryEnvironment.entry.target._tag,
        displayUrl: primaryEnvironment.displayUrl,
        ...(desktopNetworkAccess.data
          ? { advertisedEndpoints: desktopNetworkAccess.data.advertisedEndpoints }
          : {}),
      })
    : "not-detected";
  const readiness = jarvisOnboardingReadiness({
    primaryNodeId: primaryEnvironmentId ?? "primary",
    primaryReachability:
      primaryNode?.reachability ??
      (primaryEnvironment?.connection.phase === "connected" ? "online" : "offline"),
    capabilities,
    catalog: catalog ?? { nodes: [], projects: [], providers: [] },
  });
  const readinessMessage = readiness.ready
    ? "All required execution resources are connected."
    : readiness.reason === "connection-required"
      ? "Connect this node before marking setup complete."
      : readiness.reason === "execution-node-required"
        ? "Pair an online execution node before marking setup complete."
        : readiness.reason === "project-required"
          ? "Add a project on the execution node before marking setup complete."
          : "Sign in to a ready provider on the execution node before marking setup complete.";
  const complete = useCallback(() => {
    if (!readiness.ready) return;
    if (typeof window !== "undefined") {
      writeJarvisOnboardingCompletion(window.localStorage);
    }
    onOpenChange(false);
  }, [onOpenChange, readiness.ready]);

  const activeStepIndex = jarvisOnboardingStepIndex(activeStep);
  const continueSetup = useCallback(async () => {
    if (activeStep === "device" && !(await saveLabel())) return;
    setActiveStep((current) => jarvisOnboardingNextStep(current));
  }, [activeStep, saveLabel]);
  const goBack = useCallback(() => {
    setActiveStep((current) => jarvisOnboardingPreviousStep(current));
  }, []);
  const canContinue = activeStep !== "device" || (primaryEnvironmentId !== null && !labelSaving);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogPopup className="w-full max-w-2xl overflow-hidden rounded-2xl border-border/80 p-0">
        <header className="border-b border-border/65 bg-muted/18 px-5 py-5 pr-12">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-info/35 bg-info/10 text-info-foreground">
              <SparklesIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="font-mono text-base tracking-tight">
                Set up Jarvis
              </DialogTitle>
              <DialogDescription className="mt-1 max-w-xl text-sm">
                A guided check of this node. Jarvis uses the existing T3 connections, provider
                settings, and project flows already configured here.
              </DialogDescription>
            </div>
          </div>
        </header>

        <DialogPanel className="space-y-5 p-5">
          <nav aria-label="Jarvis setup progress" className="grid grid-cols-3 gap-1.5">
            {jarvisOnboardingSteps.map((step, index) => (
              <Button
                key={step.id}
                type="button"
                size="xs"
                variant={step.id === activeStep ? "secondary" : "ghost"}
                className="justify-start px-2 text-left"
                aria-current={step.id === activeStep ? "step" : undefined}
                disabled={index > activeStepIndex}
                onClick={() => setActiveStep(step.id)}
              >
                <span className="font-mono text-[9px] text-muted-foreground">0{index + 1}</span>
                <span className="truncate">{step.label}</span>
              </Button>
            ))}
          </nav>

          {activeStep === "device" ? (
            <section aria-labelledby="jarvis-onboarding-device" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2
                  id="jarvis-onboarding-device"
                  className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
                >
                  01 · Device
                </h2>
                <ServerIcon className="size-3.5 text-muted-foreground" />
              </div>
              <div className="rounded-xl border border-border/70 bg-muted/10 p-3">
                <label className="block space-y-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    Name this device
                  </span>
                  <input
                    value={labelValue}
                    maxLength={80}
                    onChange={(event) => {
                      setLabelDraft(event.target.value);
                      setLabelError(null);
                    }}
                    className="h-9 w-full rounded-md border border-border/70 bg-background px-2.5 text-sm outline-none focus:border-info"
                    placeholder="This device"
                    aria-invalid={labelError !== null}
                    aria-describedby={labelError !== null ? "jarvis-device-name-error" : undefined}
                  />
                </label>
                <p className="mt-2 text-xs text-muted-foreground">
                  Jarvis uses this name anywhere this node appears. It saves when you continue.
                </p>
                {labelError ? (
                  <p
                    id="jarvis-device-name-error"
                    className="mt-2 text-xs text-destructive-foreground"
                    role="alert"
                  >
                    {labelError}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeStep === "essentials" ? (
            <section aria-labelledby="jarvis-onboarding-essentials" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2
                  id="jarvis-onboarding-essentials"
                  className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
                >
                  02 · Essentials
                </h2>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-border/70 px-2 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                    {jarvisNodePresetLabel(capabilities.preset)} ·{" "}
                    {jarvisNodeCapabilitySummary(capabilities)}
                  </span>
                  <ShieldCheckIcon className="size-3.5 text-muted-foreground" />
                </div>
              </div>
              <div className="rounded-xl border border-border/70 bg-muted/10 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <NetworkIcon className="mt-0.5 size-4 shrink-0 text-info-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Connection health</p>
                      <p className="text-xs text-muted-foreground">
                        {primaryEnvironment?.connection.phase === "connected"
                          ? "Authenticated Jarvis session is healthy."
                          : "Connect this node to check its authenticated session."}
                      </p>
                    </div>
                  </div>
                  <span
                    className={
                      primaryEnvironment?.connection.phase === "connected"
                        ? "font-mono text-[10px] uppercase text-success"
                        : "font-mono text-[10px] uppercase text-warning-foreground"
                    }
                  >
                    {primaryEnvironment?.connection.phase === "connected"
                      ? "Connected"
                      : "Needs connection"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Route: <span className="font-medium text-foreground">{connectionRoute}</span>.{" "}
                  {tailscaleStatus === "route-detected"
                    ? "Tailscale is available for this route."
                    : "Tailscale is optional route metadata, not a health check."}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button type="button" size="xs" variant="ghost" onClick={() => refreshCatalog()}>
                    Refresh <Spinner className={pending ? "size-3" : "hidden"} />
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      dismiss();
                      onOpenConnections();
                    }}
                  >
                    Open Connections <ChevronRightIcon />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Providers
                  </h3>
                  {capabilities.providers && primaryProviders.length === 0 ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        dismiss();
                        onOpenProviderSettings();
                      }}
                    >
                      Manage <Settings2Icon />
                    </Button>
                  ) : null}
                </div>
                {!capabilities.providers ? (
                  <p className="rounded-lg border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                    This controller uses providers on its paired execution node.
                  </p>
                ) : primaryProviders.length > 0 ? (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {primaryProviders.map(({ snapshot }) => {
                      const status = classifyJarvisOnboardingProvider(snapshot);
                      const option = getDriverOption(snapshot.driver);
                      const ProviderIcon = option?.icon;
                      return (
                        <button
                          key={snapshot.instanceId}
                          type="button"
                          className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-left hover:bg-muted/20"
                          onClick={() => {
                            dismiss();
                            onOpenProviderSettings();
                          }}
                        >
                          {ProviderIcon ? (
                            <ProviderIcon className="size-4 shrink-0" />
                          ) : (
                            <CircleIcon
                              className={`size-2.5 shrink-0 fill-current ${providerStatusClass(status)}`}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {snapshot.displayName ?? option?.label ?? snapshot.driver}
                          </span>
                          <span
                            className={`shrink-0 font-mono text-[10px] uppercase ${providerStatusClass(status)}`}
                          >
                            {jarvisOnboardingProviderStatusLabel(status)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    No provider status is available yet.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Projects
                  </h3>
                  <FolderGit2Icon className="size-3.5 text-muted-foreground" />
                </div>
                {!capabilities.projects ? (
                  <p className="rounded-lg border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                    Projects stay on the paired execution node.
                  </p>
                ) : primaryProjects.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {primaryProjects.map((project) => (
                      <span
                        key={`${project.ref.nodeId}:${project.ref.projectId}`}
                        className="rounded-lg border border-border/70 bg-muted/10 px-2.5 py-1.5 text-xs"
                        title={project.workspaceRoot}
                      >
                        {project.title}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    No projects are configured on this node yet.
                  </p>
                )}
                {capabilities.projects ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      dismiss();
                      openCommandPalette({ open: "add-project" });
                    }}
                  >
                    Add project in T3 <ChevronRightIcon />
                  </Button>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeStep === "ready" ? (
            <section aria-labelledby="jarvis-onboarding-ready" className="space-y-3">
              <h2
                id="jarvis-onboarding-ready"
                className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
              >
                03 · Ready
              </h2>
              <div className="rounded-xl border border-border/70 bg-muted/10 px-3 py-3">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <CheckCircle2Icon
                    className={
                      readiness.ready ? "size-4 text-success" : "size-4 text-warning-foreground"
                    }
                  />
                  {readinessMessage}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  You can revisit any completed step above before finishing setup.
                </p>
              </div>
            </section>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground"
            >
              <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
        </DialogPanel>

        <DialogFooter className="items-center sm:flex-row sm:justify-between">
          <Button type="button" variant="ghost" onClick={goBack} disabled={activeStepIndex === 0}>
            Back
          </Button>
          {activeStep === "ready" ? (
            <Button type="button" onClick={complete} disabled={!readiness.ready}>
              {readiness.ready ? "Ready" : "Finish setup"}
            </Button>
          ) : (
            <Button type="button" onClick={() => void continueSetup()} disabled={!canContinue}>
              Continue <ChevronRightIcon />
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function shouldShowJarvisOnboarding(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !readJarvisOnboardingCompletion(window.localStorage);
  } catch {
    return false;
  }
}

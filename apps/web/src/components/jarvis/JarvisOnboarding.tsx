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
import { useCallback, useEffect, useMemo, useState } from "react";

import type { JarvisMeshCatalog } from "@t3tools/client-runtime/jarvis/mesh";
import { openCommandPalette } from "../../commandPaletteBus";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom } from "../../state/server";
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
  jarvisTailscaleStatus,
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
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dismiss = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPending(true);
    setError(null);
    void refreshMesh(undefined).then((result) => {
      if (!active) return;
      setPending(false);
      if (result._tag === "Failure") {
        setError("Could not refresh the Jarvis node.");
        return;
      }
      setCatalog(result.value);
    });
    return () => {
      active = false;
    };
  }, [open, refreshMesh]);

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
          <section aria-labelledby="jarvis-onboarding-node" className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2
                id="jarvis-onboarding-node"
                className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
              >
                01 · Device & node type
              </h2>
              <span className="font-mono text-[10px] text-muted-foreground">Installer preset</span>
            </div>
            <div className="rounded-xl border border-border/70 bg-muted/10 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <ServerIcon className="mt-0.5 size-4 shrink-0 text-info-foreground" />
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                      Device name
                    </p>
                    <p className="truncate text-sm font-semibold">
                      {primaryEnvironment?.label ?? primaryNode?.label ?? "This device"}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                      {jarvisNodePresetLabel(capabilities.preset)} ·{" "}
                      {jarvisNodeCapabilitySummary(capabilities)}
                    </p>
                  </div>
                </div>
                <ShieldCheckIcon className="size-4 shrink-0 text-success" />
              </div>
              {primaryEnvironmentId !== null ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => {
                    dismiss();
                    onOpenConnections(primaryEnvironmentId, "rename");
                  }}
                >
                  Rename device <ChevronRightIcon />
                </Button>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                {jarvisNodePresetLabel(capabilities.preset)} · The preset is selected by the
                installer and server configuration. This guide shows it but does not change it.
              </p>
            </div>
          </section>

          <section aria-labelledby="jarvis-onboarding-connection" className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2
                id="jarvis-onboarding-connection"
                className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
              >
                02 · Tailscale
              </h2>
              <NetworkIcon className="size-3.5 text-muted-foreground" />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {tailscaleStatus === "route-detected" ? "Route detected" : "Not detected"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {connectionRoute}. This identifies the current Tailscale route, not daemon state.
                  Configure Tailscale and network access in Connections.
                </p>
              </div>
              <span
                className={
                  tailscaleStatus === "route-detected"
                    ? "shrink-0 font-mono text-[10px] uppercase text-success"
                    : "shrink-0 font-mono text-[10px] uppercase text-warning-foreground"
                }
              >
                {tailscaleStatus === "route-detected" ? "Route detected" : "Not detected"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1">
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
          </section>

          <section aria-labelledby="jarvis-onboarding-providers" className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2
                id="jarvis-onboarding-providers"
                className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
              >
                03 · Providers
              </h2>
              {pending ? <Spinner className="size-3" /> : null}
            </div>
            {!capabilities.providers ? (
              <div className="rounded-xl border border-border/70 bg-muted/10 px-3 py-3 text-xs text-muted-foreground">
                Controller nodes do not run local providers. Pair an execution node to run tasks.
              </div>
            ) : primaryProviders.length > 0 ? (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {primaryProviders.map(({ snapshot }) => {
                  const status = classifyJarvisOnboardingProvider(snapshot);
                  const providerLabel =
                    snapshot.displayName ??
                    getDriverOption(snapshot.driver)?.label ??
                    snapshot.driver;
                  return (
                    <div
                      key={snapshot.instanceId}
                      className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <CircleIcon
                          className={`size-2.5 fill-current ${providerStatusClass(status)}`}
                        />
                        <span className="truncate text-sm">{providerLabel}</span>
                      </div>
                      <span
                        className={`shrink-0 font-mono text-[10px] uppercase ${providerStatusClass(status)}`}
                      >
                        {jarvisOnboardingProviderStatusLabel(status)}
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          dismiss();
                          onOpenProviderSettings();
                        }}
                      >
                        {status === "sign-in" ? "Sign in" : "Manage"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-xl border border-border/70 px-3 py-3 text-xs text-muted-foreground">
                No provider status has arrived yet. T3 will keep checking this node.
              </p>
            )}
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
                Manage providers in T3 settings <Settings2Icon />
              </Button>
            ) : null}
          </section>

          <section aria-labelledby="jarvis-onboarding-projects" className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2
                id="jarvis-onboarding-projects"
                className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
              >
                04 · Projects
              </h2>
              <FolderGit2Icon className="size-3.5 text-muted-foreground" />
            </div>
            {!capabilities.projects ? (
              <div className="rounded-xl border border-border/70 bg-muted/10 px-3 py-3 text-xs text-muted-foreground">
                Controller nodes do not own local projects. Projects stay on execution nodes.
              </div>
            ) : (
              <>
                {primaryProjects.length > 0 ? (
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
                  <p className="rounded-xl border border-border/70 px-3 py-3 text-xs text-muted-foreground">
                    No projects are configured on this node yet. Add one through the existing T3
                    project flow.
                  </p>
                )}
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
              </>
            )}
          </section>

          {error ? (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive-foreground">
              <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
        </DialogPanel>

        <DialogFooter className="items-center sm:flex-row sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2Icon
              className={
                readiness.ready ? "size-3.5 text-success" : "size-3.5 text-warning-foreground"
              }
            />
            {readinessMessage}
          </p>
          <Button type="button" onClick={complete} disabled={!readiness.ready}>
            {readiness.ready ? "Ready" : "Finish setup"}
          </Button>
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

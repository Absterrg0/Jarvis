import type { DesktopCirceOrbCatalog, DesktopCirceOrbSelection } from "@t3tools/contracts";
import type { CirceMeshCatalog, CirceMeshProvider } from "@circe/client-runtime/circe/mesh";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

export interface DesktopOrbCatalogInput {
  readonly providers: ReadonlyArray<CirceMeshProvider>;
  readonly nodeId: EnvironmentId;
  readonly selected: DesktopCirceOrbSelection | null;
  readonly pendingSelection?: DesktopCirceOrbSelection | null;
  readonly error?: string | null;
  readonly agents?: DesktopCirceOrbCatalog["agents"];
}

/**
 * Orb picker shortlist: one row per provider, at most six rows. Each entry
 * carries only its preferred model (the `isDefault` model, else the first
 * advertised model) so the picker stays a compact provider switcher instead
 * of a full model list. Ids, names, and slugs pass through verbatim; nothing
 * is invented. Unavailable providers stay listed with their honest flag.
 */
export const DESKTOP_CIRCE_ORB_SHORTLIST_LIMIT = 6;

/**
 * Build the orb picker catalog from the owning node's real provider
 * snapshot. Instance ids, display names, drivers, and model slugs pass
 * through verbatim; nothing is invented. Unavailable providers stay listed
 * with their honest flag so the picker never hides a broken default.
 */
export function buildDesktopCirceOrbCatalog(input: DesktopOrbCatalogInput): DesktopCirceOrbCatalog {
  const shortlist: Array<DesktopCirceOrbCatalog["providers"][number]> = [];
  for (const provider of input.providers) {
    if (provider.nodeId !== input.nodeId) continue;
    if (shortlist.length >= DESKTOP_CIRCE_ORB_SHORTLIST_LIMIT) break;
    const models = provider.snapshot.models ?? [];
    if (models.length === 0) continue;
    const preferred = models.find((model) => model.isDefault === true) ?? models[0];
    if (preferred === undefined || typeof preferred.slug !== "string") continue;
    shortlist.push({
      instanceId: provider.snapshot.instanceId,
      displayName: provider.snapshot.displayName ?? provider.snapshot.driver,
      driver: provider.snapshot.driver,
      available: provider.available,
      models: [{ slug: preferred.slug, name: preferred.name ?? preferred.slug }],
    });
  }
  return {
    providers: shortlist,
    selected: input.selected,
    pendingSelection: input.pendingSelection ?? null,
    error: input.error ?? null,
    agents: input.agents ?? [],
  };
}

/** Read the existing task shell stream; the activity panel owns no polling or execution. */
export function buildDesktopCirceOrbAgents(
  threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      | "id"
      | "environmentId"
      | "projectId"
      | "title"
      | "archivedAt"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "backgroundLiveness"
      | "modelSelection"
    > & {
      readonly session: Pick<NonNullable<EnvironmentThreadShell["session"]>, "status"> | null;
    }
  >,
  catalog: CirceMeshCatalog | null,
): NonNullable<DesktopCirceOrbCatalog["agents"]> {
  const nodes = new Map(catalog?.nodes.map((node) => [node.nodeId, node]));
  const projects = new Map(
    catalog?.projects.map((project) => [
      JSON.stringify([project.ref.nodeId, project.ref.projectId]),
      project.title,
    ]),
  );
  const providers = new Map(
    catalog?.providers.map((provider) => [
      JSON.stringify([provider.nodeId, provider.snapshot.instanceId]),
      provider.snapshot.displayName,
    ]),
  );
  return threads.flatMap((thread) => {
    if (thread.archivedAt !== null) return [];
    const node = nodes.get(thread.environmentId);
    if (!node) return [];
    const status =
      thread.hasPendingApprovals || thread.hasPendingUserInput
        ? "waiting"
        : thread.session?.status === "starting"
          ? "starting"
          : thread.session?.status === "running" || thread.backgroundLiveness === "working"
            ? "running"
            : thread.backgroundLiveness === "monitoring"
              ? "monitoring"
              : null;
    if (status === null) return [];
    return [
      {
        taskRef: { executionNodeId: thread.environmentId, threadId: thread.id },
        title: thread.title,
        projectTitle:
          projects.get(JSON.stringify([thread.environmentId, thread.projectId])) ??
          "Project unavailable",
        nodeLabel: node.label,
        providerLabel:
          providers.get(JSON.stringify([thread.environmentId, thread.modelSelection.instanceId])) ??
          thread.modelSelection.instanceId,
        status: node.reachability === "online" ? status : "offline",
      },
    ];
  });
}

/** Membership check against the live catalog. Rejects invented ids. */
export function isDesktopCirceOrbSelectionValid(
  selection: DesktopCirceOrbSelection,
  catalog: DesktopCirceOrbCatalog,
): boolean {
  const provider = catalog.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (provider === undefined) return false;
  return provider.models.some((model) => model.slug === selection.model);
}

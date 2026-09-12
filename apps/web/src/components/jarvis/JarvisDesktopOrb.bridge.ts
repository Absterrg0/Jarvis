import type { DesktopJarvisOrbCatalog, DesktopJarvisOrbSelection } from "@t3tools/contracts";
import type { JarvisMeshProvider } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type { EnvironmentId } from "@t3tools/contracts";

export interface DesktopOrbCatalogInput {
  readonly providers: ReadonlyArray<JarvisMeshProvider>;
  readonly nodeId: EnvironmentId;
  readonly selected: DesktopJarvisOrbSelection | null;
  readonly pendingSelection?: DesktopJarvisOrbSelection | null;
  readonly error?: string | null;
}

/**
 * Orb picker shortlist: one row per provider, at most six rows. Each entry
 * carries only its preferred model (the `isDefault` model, else the first
 * advertised model) so the picker stays a compact provider switcher instead
 * of a full model list. Ids, names, and slugs pass through verbatim; nothing
 * is invented. Unavailable providers stay listed with their honest flag.
 */
export const DESKTOP_JARVIS_ORB_SHORTLIST_LIMIT = 6;

/**
 * Build the orb picker catalog from the owning node's real provider
 * snapshot. Instance ids, display names, drivers, and model slugs pass
 * through verbatim; nothing is invented. Unavailable providers stay listed
 * with their honest flag so the picker never hides a broken default.
 */
export function buildDesktopJarvisOrbCatalog(
  input: DesktopOrbCatalogInput,
): DesktopJarvisOrbCatalog {
  const shortlist: Array<DesktopJarvisOrbCatalog["providers"][number]> = [];
  for (const provider of input.providers) {
    if (provider.nodeId !== input.nodeId) continue;
    if (shortlist.length >= DESKTOP_JARVIS_ORB_SHORTLIST_LIMIT) break;
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
  };
}

/** Membership check against the live catalog. Rejects invented ids. */
export function isDesktopJarvisOrbSelectionValid(
  selection: DesktopJarvisOrbSelection,
  catalog: DesktopJarvisOrbCatalog,
): boolean {
  const provider = catalog.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (provider === undefined) return false;
  return provider.models.some((model) => model.slug === selection.model);
}

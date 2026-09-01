export const JARVIS_MOBILE_SLUG = "jarvis-mobile" as const;

export interface ExpoOwnershipEnvironment {
  readonly JARVIS_EXPO_OWNER?: string;
  readonly JARVIS_EXPO_PROJECT_ID?: string;
}

export interface ExpoOwnership {
  readonly slug: typeof JARVIS_MOBILE_SLUG;
  readonly owner?: string;
  readonly projectId?: string;
  readonly updatesUrl?: string;
}

/** Resolve the optional Jarvis-owned EAS project without inheriting upstream identity. */
export function resolveExpoOwnership(environment: ExpoOwnershipEnvironment): ExpoOwnership {
  const owner = environment.JARVIS_EXPO_OWNER?.trim() || undefined;
  const projectId = environment.JARVIS_EXPO_PROJECT_ID?.trim() || undefined;

  return {
    slug: JARVIS_MOBILE_SLUG,
    ...(owner ? { owner } : {}),
    ...(projectId
      ? {
          projectId,
          updatesUrl: `https://u.expo.dev/${projectId}`,
        }
      : {}),
  };
}

export const CIRCE_MOBILE_SLUG = "circe-mobile" as const;

export interface ExpoOwnershipEnvironment {
  readonly CIRCE_EXPO_OWNER?: string;
  readonly CIRCE_EXPO_PROJECT_ID?: string;
}

export interface ExpoOwnership {
  readonly slug: typeof CIRCE_MOBILE_SLUG;
  readonly owner?: string;
  readonly projectId?: string;
  readonly updatesUrl?: string;
}

/** Resolve the optional Circe-owned EAS project without inheriting upstream identity. */
export function resolveExpoOwnership(environment: ExpoOwnershipEnvironment): ExpoOwnership {
  const owner = environment.CIRCE_EXPO_OWNER?.trim() || undefined;
  const projectId = environment.CIRCE_EXPO_PROJECT_ID?.trim() || undefined;

  return {
    slug: CIRCE_MOBILE_SLUG,
    ...(owner ? { owner } : {}),
    ...(projectId
      ? {
          projectId,
          updatesUrl: `https://u.expo.dev/${projectId}`,
        }
      : {}),
  };
}

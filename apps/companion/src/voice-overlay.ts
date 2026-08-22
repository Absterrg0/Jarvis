export const voiceOverlaySize = { width: 524, height: 88, bottom: 48 } as const;
export const setupWindowSize = { width: 536, height: 574 } as const;
export const companionWindowMargin = 16;
export const voiceReviewOverlayMaximumHeight = 264;
export const voiceOverlaySpeechGraceDelay = 1_600;
const reviewCharactersPerLine = 43;
const reviewVerticalChrome = 52;

export type VoiceOverlaySize = Readonly<{
  readonly width: number;
  readonly height: number;
  readonly bottom: number;
}>;

export type CompanionWorkArea = Readonly<{
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}>;

export type CompanionWindowBounds = Readonly<{
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}>;

export type VoiceOverlayStatus = {
  readonly kind?: string;
  readonly detail?: string;
};

export const voiceOverlayActions = {
  attention: "open-host",
  completed: "open-host",
  speaking: "stop-speaking",
} as const;

export type VoiceOverlayAction = (typeof voiceOverlayActions)[keyof typeof voiceOverlayActions];

export function voiceOverlayActionForKind(kind?: string): VoiceOverlayAction | undefined {
  return typeof kind === "string" && kind in voiceOverlayActions
    ? voiceOverlayActions[kind as keyof typeof voiceOverlayActions]
    : undefined;
}

/**
 * The companion is a notification, not a permanent HUD. Only active capture
 * and routing states own the surface indefinitely; terminal states close it.
 */
export function voiceOverlayAutoHideDelay(status: VoiceOverlayStatus): number | undefined {
  switch (status.kind) {
    case "started":
      return 3_500;
    case "completed":
      return undefined;
    case "error":
      return 8_000;
    case "interrupted":
      return 1_200;
    case "attention":
      return 15_000;
    default:
      return undefined;
  }
}

/** A conservative line estimate keeps ordinary confirmation compact without clipping long text. */
export function estimatedVoiceReviewLines(detail: string): number {
  const lines = detail.trim().split(/\r?\n/u);
  return Math.max(
    1,
    lines.reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / reviewCharactersPerLine)),
      0,
    ),
  );
}

/** Only a long transcript-review beat grows; every other voice state stays compact. */
export function voiceOverlaySizeForStatus(status?: VoiceOverlayStatus) {
  if (status?.kind !== "review" && status?.kind !== "attention") return voiceOverlaySize;
  const height = Math.min(
    voiceReviewOverlayMaximumHeight,
    Math.max(
      voiceOverlaySize.height,
      reviewVerticalChrome + estimatedVoiceReviewLines(status.detail ?? "") * 15,
    ),
  );
  return height === voiceOverlaySize.height ? voiceOverlaySize : { ...voiceOverlaySize, height };
}

function constrainedDimension(value: number, extent: number, margin: number): number {
  return Math.max(1, Math.floor(Math.min(value, extent - margin * 2)));
}

function safeInset(extent: number, size: number, margin: number): number {
  return Math.min(margin, Math.max(0, (extent - size) / 2));
}

function centeredPosition(start: number, extent: number, size: number, margin: number): number {
  const inset = safeInset(extent, size, margin);
  const minimum = start + inset;
  const maximum = start + extent - size - inset;
  return Math.round(Math.min(maximum, Math.max(minimum, start + (extent - size) / 2)));
}

export function voiceOverlayBounds(
  area: CompanionWorkArea,
  size: VoiceOverlaySize = voiceOverlaySize,
): CompanionWindowBounds {
  const width = constrainedDimension(size.width, area.width, companionWindowMargin);
  const height = constrainedDimension(size.height, area.height, companionWindowMargin);
  const inset = safeInset(area.height, height, companionWindowMargin);
  const minimumY = area.y + inset;
  const maximumY = area.y + area.height - height - inset;
  const desiredY = area.y + area.height - height - size.bottom;
  return {
    width,
    height,
    x: centeredPosition(area.x, area.width, width, companionWindowMargin),
    y: Math.round(Math.min(maximumY, Math.max(minimumY, desiredY))),
  };
}

export function setupWindowBounds(
  area: CompanionWorkArea,
  size: Readonly<{ readonly width: number; readonly height: number }> = setupWindowSize,
): CompanionWindowBounds {
  const width = constrainedDimension(size.width, area.width, companionWindowMargin);
  const height = constrainedDimension(size.height, area.height, companionWindowMargin);
  return {
    width,
    height,
    x: centeredPosition(area.x, area.width, width, companionWindowMargin),
    y: centeredPosition(area.y, area.height, height, companionWindowMargin),
  };
}

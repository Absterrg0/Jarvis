export const voiceOverlaySize = { width: 524, height: 88, bottom: 48 } as const;
export const voiceReviewOverlayMaximumHeight = 264;
const reviewCharactersPerLine = 43;
const reviewVerticalChrome = 52;

export type VoiceOverlayStatus = {
  readonly kind?: string;
  readonly detail?: string;
};

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
  if (status?.kind !== "review") return voiceOverlaySize;
  const height = Math.min(
    voiceReviewOverlayMaximumHeight,
    Math.max(
      voiceOverlaySize.height,
      reviewVerticalChrome + estimatedVoiceReviewLines(status.detail ?? "") * 15,
    ),
  );
  return height === voiceOverlaySize.height ? voiceOverlaySize : { ...voiceOverlaySize, height };
}

import { cn } from "../../lib/utils";

/**
 * Approved Circe lockups. The horizontal logo ships as two raster-backed SVGs
 * (on-light and on-dark); both are referenced by URL so the browser caches the
 * large embedded artwork instead of inlining it twice into the bundle. The
 * mark stays a single asset for compact surfaces: rail, favicon, avatar.
 */

export const CIRCE_MARK_SRC = "/brand/circe-mark.svg";
export const CIRCE_HORIZONTAL_LIGHT_SRC = "/brand/circe-logo-horizontal-on-light.svg";
export const CIRCE_HORIZONTAL_DARK_SRC = "/brand/circe-logo-horizontal-on-dark.svg";

export function CirceMark({
  className,
  alt = "",
}: {
  readonly className?: string;
  readonly alt?: string;
}) {
  return <img alt={alt} className={cn("h-6 w-auto", className)} src={CIRCE_MARK_SRC} />;
}

/**
 * Light and dark lockups are both mounted and swapped with the `.dark` class so
 * the mark survives a theme change with no React state and no layout shift.
 */
export function CirceHorizontalLogo({
  className,
  alt = "Circe",
}: {
  readonly className?: string;
  readonly alt?: string;
}) {
  return (
    <span className={cn("inline-flex h-7 items-center", className)}>
      <img alt={alt} className="h-full w-auto dark:hidden" src={CIRCE_HORIZONTAL_LIGHT_SRC} />
      <img
        alt=""
        aria-hidden
        className="hidden h-full w-auto dark:block"
        src={CIRCE_HORIZONTAL_DARK_SRC}
      />
    </span>
  );
}

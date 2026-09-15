import { cn } from "../../lib/utils";

/**
 * The Circe orb: a dark celestial sphere with a thin incandescent copper rim,
 * an uneven warm edge, a small specular flare, and a restrained halo. Built
 * from stacked layers rather than one gradient so the rim stays crisp at every
 * size. Identity moments only. Do not scatter it across product UI.
 */
export function CirceOrb({
  size = 52,
  className,
  glow = true,
}: {
  readonly size?: number;
  readonly className?: string;
  /** The ambient halo is for hero/identity placements; turn it off inline. */
  readonly glow?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-block shrink-0 rounded-full", className)}
      style={{ width: size, height: size }}
    >
      {glow ? (
        <span
          className="absolute rounded-full"
          style={{
            inset: "-45%",
            background:
              "radial-gradient(circle, rgba(217,112,72,0.22) 0%, rgba(217,112,72,0.08) 38%, transparent 64%)",
          }}
        />
      ) : null}
      <span
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 58% 46%, #151211 0%, #100e0d 48%, #1a100c 68%, #6d3526 81%, #e18a62 91%, #ffd8bd 97%, #fff4e9 100%)",
          boxShadow:
            "0 0 3px rgba(255,238,225,0.95), 0 0 12px rgba(242,155,111,0.48), 0 0 32px rgba(205,99,63,0.28)",
        }}
      />
      <span
        className="absolute rounded-full"
        style={{
          inset: "14%",
          background:
            "radial-gradient(circle at 42% 62%, rgba(224,138,99,0.18) 0%, transparent 58%)",
        }}
      />
      <span
        className="absolute rounded-full"
        style={{
          top: "30%",
          right: "6%",
          width: "16%",
          height: "16%",
          background:
            "radial-gradient(circle, #fff7ef 0%, rgba(255,214,185,0.9) 40%, transparent 72%)",
        }}
      />
    </span>
  );
}

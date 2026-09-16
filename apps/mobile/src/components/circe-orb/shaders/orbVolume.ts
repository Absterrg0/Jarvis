/**
 * Interior volume pass.
 *
 * The missing layer. `OrbBase` is deliberately near-black, and `OrbShell` only
 * lights the hull, so between them the sphere was rendering as a flat black
 * disc. This pass puts *volume* between those two: broad, low-frequency copper
 * illumination occupying the outer 40-50% of the sphere, plus two asymmetric
 * warm lobes.
 *
 * It must never produce the old central white hotspot. The core stays dark and
 * the light only ever reaches copper and a restrained peach, never white. The
 * alpha ceiling is 0.42 so the pass reads as smoked glass, not as a second
 * opaque sphere.
 *
 * Order in the composition is base, interior ribbon, volume, shell.
 */
export const ORB_VOLUME_SKSL = `
uniform float2 center;
uniform float radius;
uniform float volumeIntensity;
uniform float energy;
uniform float4 deepColor;
uniform float4 copperColor;
uniform float4 peachColor;

half4 main(float2 xy) {
  float2 uv = (xy - center) / radius;
  float r = length(uv);
  if (r > 1.0) {
    return half4(0.0);
  }

  // Broad field hugging the inside of the hull. This is the bulk of the
  // volume, and it is why the sphere is not a black disc.
  float edgeField = smoothstep(0.30, 0.96, r);

  // Two asymmetric lobes: a lower-body glow and a left-side light. The
  // reference lighting is not radially symmetric.
  float lowerGlow = exp(
    -pow((uv.x - 0.12) / 0.78, 2.0) - pow((uv.y - 0.34) / 0.55, 2.0)
  );
  float sideGlow = exp(
    -pow((uv.x + 0.48) / 0.45, 2.0) - pow((uv.y + 0.08) / 0.75, 2.0)
  );

  float warm = edgeField * 0.22 + lowerGlow * 0.18 + sideGlow * 0.12;
  warm *= volumeIntensity * (1.0 + energy * 0.3);

  // Read through deep copper into copper, with peach only at the strongest
  // lobes. White is never reached here.
  float3 color = mix(deepColor.rgb, copperColor.rgb, smoothstep(0.0, 0.8, warm));
  color = mix(color, peachColor.rgb, smoothstep(0.7, 1.0, warm) * 0.5);

  float alpha = clamp(warm, 0.0, 0.42);
  float edge = 1.0 - smoothstep(0.985, 1.0, r);
  return half4(color * alpha * edge, alpha * edge);
}
`;

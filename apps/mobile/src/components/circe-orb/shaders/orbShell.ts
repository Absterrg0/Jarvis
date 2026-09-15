/**
 * Transparent shell pass.
 *
 * This is the *second* sphere pass. It is drawn over the refracted interior
 * fibers, which is what makes them read as being inside glass rather than as
 * lines printed on a surface.
 *
 * The hull light is uneven by construction. Three angular harmonics plus a
 * travelling phase mean the circumference is never uniformly bright, because a
 * uniformly bright ring reads as a neon tube. There is no separate circular
 * stroke anywhere in the composition; this pass is the ring.
 *
 * Alpha is returned premultiplied.
 */
export const ORB_SHELL_SKSL = `
uniform float2 center;
uniform float radius;
uniform float shellPhase;
uniform float shellIntensity;
uniform float energy;
uniform float4 copperColor;
uniform float4 peachColor;
uniform float4 hotColor;

half4 main(float2 xy) {
  float2 uv = (xy - center) / radius;
  float r = length(uv);
  if (r > 1.002) {
    return half4(0.0);
  }

  float clampedR = min(r, 1.0);
  float z = sqrt(max(0.0, 1.0 - clampedR * clampedR));

  float fresnel = pow(1.0 - z, 3.6);
  float angle = atan(uv.y, uv.x);

  // Deliberately uneven. The dominant lobe sits where the light is, and the
  // smaller harmonics keep the rest of the circumference from going flat.
  float uneven = 0.46
    + 0.30 * sin(angle - shellPhase)
    + 0.16 * sin(2.0 * angle + shellPhase * 0.7)
    + 0.10 * sin(3.0 * angle - 1.1);
  uneven = clamp(uneven, 0.08, 1.0);

  float3 color = mix(copperColor.rgb, peachColor.rgb, pow(fresnel, 1.8));
  color += hotColor.rgb * pow(fresnel, 5.0) * 0.5;

  float alpha = fresnel * uneven * shellIntensity * (1.0 + energy * 0.35);

  // A razor-thin lip exactly at the hull. This is the only place 'hot' is
  // allowed to approach full strength, and it is about a pixel wide.
  float lip = smoothstep(0.972, 0.997, r) * (1.0 - smoothstep(0.997, 1.002, r));
  alpha += lip * uneven * 0.45 * shellIntensity;
  color += hotColor.rgb * lip * 0.4;

  float clamped = clamp(alpha, 0.0, 1.0);
  return half4(color * clamped, clamped);
}
`;

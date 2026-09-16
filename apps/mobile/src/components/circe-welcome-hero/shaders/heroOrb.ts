/**
 * Luminous orb core for the welcome hero.
 *
 * Tonal balance, per the art direction:
 *   30% deep centre, 40% warm volume, 20% shell transition, 10% hot edge.
 *
 * The first version of this shader was too dark to read as the focal point of
 * an illustration. The second was too luminous: the peach shell started at 72%
 * of the radius and washed out the middle, so the object read as a flat peach
 * ball rather than a sphere with depth. The fix is to hold the deep core and
 * warm volume across the first three quarters of the radius and keep the shell
 * and hot edge to the outer band, which is where a real lit sphere puts them.
 *
 * The rim is modulated by three angular harmonics plus a travel phase so the
 * circumference is never uniformly bright. A cheap value hash adds faint grain
 * so the volume is not a mathematically smooth disc.
 */
export const HERO_ORB_SKSL = `
uniform float2 center;
uniform float radius;
uniform float phase;
uniform float4 coreColor;
uniform float4 warmColor;
uniform float4 copperColor;
uniform float4 peachColor;
uniform float4 hotColor;

float hash21(float2 p) {
  return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
}

half4 main(float2 xy) {
  float2 uv = (xy - center) / radius;
  float r = length(uv);
  if (r > 1.0) {
    return half4(0.0);
  }

  // Body volume. The deep core reaches to about 55% of the radius, which is
  // roughly 30% of the visible area, then warm brown, then copper. Nothing
  // here is allowed near black.
  float3 color = mix(coreColor.rgb, warmColor.rgb, smoothstep(0.05, 0.62, r));
  color = mix(color, copperColor.rgb, smoothstep(0.5, 0.85, r));
  color = mix(color, peachColor.rgb, smoothstep(0.84, 0.98, r) * 0.6);

  // One broad internal glow low and left, so the volume is not a flat disc.
  float2 glowUv = uv - float2(-0.24, 0.3);
  float glow = exp(-dot(glowUv, glowUv) / 0.4);
  color += copperColor.rgb * glow * 0.1;

  // Faint internal grain, so the surface has some tooth without reading as
  // noise or dither. Scaled down at the rim where the hot edge takes over.
  float grain = hash21(floor(xy * 1.7)) - 0.5;
  color += grain * 0.05 * (1.0 - smoothstep(0.7, 1.0, r));

  // Uneven hot edge.
  float angle = atan(uv.y, uv.x);
  float uneven = 0.5
    + 0.26 * sin(angle + phase)
    + 0.15 * sin(2.0 * angle - phase * 0.6)
    + 0.09 * sin(3.0 * angle + 1.3);
  uneven = clamp(uneven, 0.0, 1.0);

  float lip = smoothstep(0.955, 0.997, r) * (1.0 - smoothstep(0.997, 1.0, r));
  color += hotColor.rgb * lip * (0.4 + 0.6 * uneven);

  float edge = 1.0 - smoothstep(0.985, 1.0, r);
  return half4(color * edge, edge);
}
`;

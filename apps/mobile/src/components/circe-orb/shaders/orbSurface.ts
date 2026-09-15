/**
 * Sphere surface shader.
 *
 * Every pixel inside the circle is treated as a point on an imaginary sphere:
 * `uv` is the pixel offset from the sphere centre in units of its radius, so
 * `r` is the normalized distance from the centre and `z` is reconstructed from
 * the unit circle. That yields a real surface normal, so the body can be lit as
 * an object instead of painted as a flat radial gradient.
 *
 * Derived from the sphere centre rather than the canvas size on purpose: the
 * canvas is not square (the fiber field makes it taller), and mapping from the
 * canvas would place the sphere's surface off-centre from its own rim.
 *
 * The reference object is a glowing copper sphere, not a black one. The read
 * comes from three things in order: a bright interior, a deep falloff toward
 * the hull, and a crisp ring exactly at the hull. The ring is what makes it
 * look lit rather than airbrushed, so it carries more weight than the interior.
 *
 * The ring is modulated by angle so it is not uniformly bright around the
 * circumference; a perfectly even neon circle reads as synthetic.
 *
 * Colors arrive as uniforms so light and dark mode share this geometry and
 * differ only in tuning.
 */
export const ORB_SURFACE_SKSL = `
uniform float2 center;
uniform float radius;
uniform float level;
uniform float rimPhase;
uniform float rimIntensity;
uniform float warmth;
uniform float edgeDepth;
uniform float4 hotColor;
uniform float4 copperColor;
uniform float4 deepColor;
uniform float4 rimColor;

half4 main(float2 xy) {
  float2 uv = (xy - center) / radius;
  float r = length(uv);
  if (r > 1.0) {
    return half4(0.0);
  }

  float z = sqrt(max(0.0, 1.0 - r * r));
  float3 normal = normalize(float3(uv.x, uv.y, z));
  float3 lightDir = normalize(float3(-0.42, -0.5, 0.76));
  float diffuse = max(dot(normal, lightDir), 0.0);

  // Body: a small hot core, a copper field, then a deep falloff at the hull so
  // the sphere has a defined boundary instead of airbrushing into the page.
  float3 color = mix(hotColor.rgb, copperColor.rgb, smoothstep(0.0, 0.34, r));
  color = mix(color, deepColor.rgb, smoothstep(0.44, 1.0, r) * edgeDepth);

  // Directional highlight, upper-left. Kept small: a large hotspot reads as a
  // washed-out ball rather than as a glowing object.
  color += hotColor.rgb * pow(diffuse, 4.5) * 0.18 * warmth;

  // Hull ring. Angular modulation keeps it from reading as neon.
  float fresnel = pow(1.0 - z, 7.0);
  float angle = atan(uv.y, uv.x);
  float angular = 0.7 + 0.3 * sin(angle - rimPhase);
  color += rimColor.rgb * fresnel * 2.6 * angular * rimIntensity;
  color += rimColor.rgb * fresnel * level * 0.9 * rimIntensity;

  float edge = 1.0 - smoothstep(0.99, 1.0, r);
  return half4(color * edge, edge);
}
`;

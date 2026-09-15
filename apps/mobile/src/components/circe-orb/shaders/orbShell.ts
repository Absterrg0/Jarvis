/**
 * Transparent shell pass.
 *
 * This is the *second* sphere pass. It is drawn over the refracted interior
 * fibers, which is what makes them read as being inside glass rather than as
 * lines printed on a surface.
 *
 * Design system v1 specifies the lighting explicitly: the strongest warm region
 * sits upper-left and lower-left, with a small brilliant specular flare on the
 * right edge, and a thin incandescent lip at the hull. That is expressed here as
 * three angular lobes rather than a sum of harmonics, because the reference
 * lighting is art-directed rather than a standing wave.
 *
 * Alpha is returned premultiplied.
 */
export const ORB_SHELL_SKSL = `
uniform float2 center;
uniform float radius;
uniform float shellPhase;
uniform float shellIntensity;
uniform float energy;
uniform float4 deepColor;
uniform float4 copperColor;
uniform float4 peachColor;
uniform float4 hotColor;

// Wrapped angular distance to a target angle, in radians.
float angleDistance(float angle, float target) {
  float d = angle - target;
  return atan(sin(d), cos(d));
}

// Gaussian falloff around a target direction.
float lobe(float angle, float target, float width) {
  float d = angleDistance(angle, target) / width;
  return exp(-d * d);
}

half4 main(float2 xy) {
  float2 uv = (xy - center) / radius;
  float r = length(uv);
  if (r > 1.002) {
    return half4(0.0);
  }

  float clampedR = min(r, 1.0);
  float z = sqrt(max(0.0, 1.0 - clampedR * clampedR));

  // Art-directed, not physical. A 'pow(1 - z, n)' falloff with n above ~2 is
  // what produced a hairline of light on an otherwise black disc: it stays
  // almost zero until the final pixels. Two explicit fields are far easier to
  // reason about, and the shell body starts around 46% of the radius.
  float bodyShell = smoothstep(0.46, 0.90, r);
  float outerShell = smoothstep(0.76, 0.985, r);
  float fresnel = clamp(bodyShell * 0.55 + outerShell * 0.75, 0.0, 1.0);
  float angle = atan(uv.y, uv.x);

  // The two broad warm regions travel slowly, so the object is never static
  // without ever reading as animated.
  float drift = sin(shellPhase) * 0.16;
  float upperLeft = lobe(angle, 2.356 + drift, 0.95);
  float lowerLeft = lobe(angle, 3.927 - drift, 0.95);
  // A narrow, brilliant flare on the right edge.
  float specular = lobe(angle, 0.0 + drift * 0.5, 0.30);

  float uneven = 0.20 + 0.46 * upperLeft + 0.42 * lowerLeft + 0.70 * specular;
  uneven = clamp(uneven, 0.0, 1.0);

  // Read outward through the ramp so the dark body meets the shell through
  // deep copper instead of jumping straight to a bright edge.
  float3 color = mix(deepColor.rgb, copperColor.rgb, smoothstep(0.0, 0.55, fresnel));
  color = mix(color, peachColor.rgb, smoothstep(0.45, 0.9, fresnel));
  color += hotColor.rgb * pow(fresnel, 6.0) * 0.55 * (0.35 + specular);

  float alpha = fresnel * uneven * shellIntensity * (1.0 + energy * 0.35);

  // The thin incandescent lip at the hull. Design system v1 gives this as a
  // ~3px near-white ring at full opacity; at orb scale that is about one point.
  float lip = smoothstep(0.968, 0.996, r) * (1.0 - smoothstep(0.996, 1.002, r));
  alpha += lip * (0.35 + 0.65 * uneven) * 0.6 * shellIntensity;
  color += hotColor.rgb * lip * 0.5;

  float clamped = clamp(alpha, 0.0, 1.0);
  return half4(color * clamped, clamped);
}
`;

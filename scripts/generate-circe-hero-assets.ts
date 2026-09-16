#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This small raster export CLI is intentionally a synchronous ImageMagick boundary.

/**
 * Render the welcome hero's orb layers.
 *
 * The welcome hero uses two baked transparent layers instead of reproducing a
 * rendered sphere with radial shader ramps. Radius-driven ramps read as
 * concentric bands: they cannot express asymmetric directional lighting, a
 * Fresnel rim, or a specular lobe, so the object looks like a gradient rather
 * than a lit sphere. Without the source render available, these are shaded
 * analytically from the reconstructed sphere normal, and the dynamic interior
 * ribbon is composited between the two layers at runtime.
 *
 *   hero-orb-body.webp   opaque brown/copper volumetric body, internal
 *                        illumination, limb darkening
 *   hero-orb-glass.webp  mostly transparent shell: Fresnel rim, specular
 *                        hotspots, faint face tint
 *
 * These are hero-only. `CirceOrb` stays fully procedural for product states.
 *
 * Writes PAM intermediates and converts with ImageMagick, matching the existing
 * brand-asset pipeline so no extra raster dependency enters the repo.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const outputDir = NodePath.join(repoRoot, "apps/mobile/assets/hero");
const SIZE = 1024;

type Rgb = readonly [number, number, number];

const CORE: Rgb = [42, 23, 16];
const DEEP: Rgb = [58, 34, 24];
const WARM: Rgb = [110, 69, 52];
const COPPER: Rgb = [185, 120, 91];
const PEACH: Rgb = [242, 201, 172];
const HOT: Rgb = [255, 242, 229];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, t));
  return [
    a[0] + (b[0] - a[0]) * clamped,
    a[1] + (b[1] - a[1]) * clamped,
    a[2] + (b[2] - a[2]) * clamped,
  ];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Key light: upper left and in front. Fill: lower right, warm and weak. */
const KEY = normalize([-0.55, -0.62, 0.56]);
const FILL = normalize([0.72, 0.4, 0.57]);
const VIEW: readonly [number, number, number] = [0, 0, 1];
const KEY_HALF = normalize([KEY[0] + VIEW[0], KEY[1] + VIEW[1], KEY[2] + VIEW[2]]);
const FILL_HALF = normalize([FILL[0] + VIEW[0], FILL[1] + VIEW[1], FILL[2] + VIEW[2]]);

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Shading terms shared by both layers, derived from the sphere normal. */
function sample(normal: readonly [number, number, number]): {
  readonly keyDiffuse: number;
  readonly fillDiffuse: number;
  readonly fresnel: number;
  readonly keySpecular: number;
  readonly fillSpecular: number;
} {
  return {
    keyDiffuse: Math.max(dot(normal, KEY), 0),
    fillDiffuse: Math.max(dot(normal, FILL), 0),
    // Exponent 2.5 rather than 3: the tighter falloff produced a rim only a
    // pixel or two wide, which at hero scale read as a hairline rather than as
    // the thickness of a glass shell.
    fresnel: (1 - normal[2]) ** 2.5,
    keySpecular: Math.max(dot(normal, KEY_HALF), 0) ** 150,
    fillSpecular: Math.max(dot(normal, FILL_HALF), 0) ** 24,
  };
}

/**
 * Opaque body. Asymmetric key/fill diffuse so the lighting has a clear
 * direction, a subsurface glow for internal illumination, and limb darkening so
 * the sphere reads as a volume and separates from the glass shell.
 */
function shadeBody(): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const radius = SIZE / 2 - 2;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const ux = (x + 0.5 - SIZE / 2) / radius;
      const uy = (y + 0.5 - SIZE / 2) / radius;
      const d = Math.hypot(ux, uy);
      if (d >= 1) continue;

      const normal: [number, number, number] = [ux, uy, Math.sqrt(Math.max(0, 1 - d * d))];
      const { keyDiffuse, fillDiffuse } = sample(normal);

      let colour = mix(CORE, DEEP, smoothstep(0, 0.35, keyDiffuse));
      colour = mix(colour, WARM, smoothstep(0.2, 0.62, keyDiffuse));
      colour = mix(colour, COPPER, smoothstep(0.5, 0.9, keyDiffuse));

      colour = [
        colour[0] + COPPER[0] * fillDiffuse * 0.22,
        colour[1] + COPPER[1] * fillDiffuse * 0.22,
        colour[2] + COPPER[2] * fillDiffuse * 0.22,
      ];

      // Subsurface: warm light pooling inside the body, offset from centre.
      const gx = ux + 0.2;
      const gy = uy - 0.18;
      const glow = Math.exp(-((gx * gx + gy * gy) / 0.3));
      colour = [
        colour[0] + COPPER[0] * glow * 0.3,
        colour[1] + COPPER[1] * glow * 0.3,
        colour[2] + COPPER[2] * glow * 0.3,
      ];

      const gx2 = ux - 0.16;
      const gy2 = uy + 0.1;
      const glow2 = Math.exp(-((gx2 * gx2 + gy2 * gy2) / 0.38));
      colour = [
        colour[0] + WARM[0] * glow2 * 0.16,
        colour[1] + WARM[1] * glow2 * 0.16,
        colour[2] + WARM[2] * glow2 * 0.16,
      ];

      // Directional falloff gives the sphere a real terminator. Without it the
      // body is evenly lit everywhere and reads as a glossy ball rather than a
      // volume. The floor is kept well above black so the shadow side stays warm
      // brown instead of going dead, and the Fresnel rim on the glass layer
      // lifts the silhouette back out.
      const shade = 0.24 + 0.76 * keyDiffuse ** 0.85;
      // Limb darkening tightens the silhouette against the glass shell.
      const limb = (0.78 + 0.22 * normal[2]) * shade;
      colour = [colour[0] * limb, colour[1] * limb, colour[2] * limb];

      const edge = Math.min(1, ((1 - d) * radius) / 1.2);
      pixels[offset] = Math.min(255, Math.round(colour[0]));
      pixels[offset + 1] = Math.min(255, Math.round(colour[1]));
      pixels[offset + 2] = Math.min(255, Math.round(colour[2]));
      pixels[offset + 3] = Math.round(edge * 255);
    }
  }
  return pixels;
}

/**
 * Mostly transparent shell. The face stays nearly clear so the interior ribbon
 * reads through it; the shell shows up as a Fresnel rim plus two specular
 * lobes, one tight and one broad.
 */
function shadeGlass(): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const radius = SIZE / 2 - 2;
  // The face must stay nearly clear so the interior ribbon reads through it.
  // An earlier value plus a broad sheen washed the body out into polished
  // metal, which is the opposite of glass over warm copper.
  const faceTint = 0.012;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const ux = (x + 0.5 - SIZE / 2) / radius;
      const uy = (y + 0.5 - SIZE / 2) / radius;
      const d = Math.hypot(ux, uy);
      if (d >= 1) continue;

      const normal: [number, number, number] = [ux, uy, Math.sqrt(Math.max(0, 1 - d * d))];
      const { fresnel, keySpecular, fillSpecular } = sample(normal);

      const alpha = Math.min(1, faceTint + fresnel + keySpecular * 0.95 + fillSpecular * 0.03);

      // Rim reads peach; the specular lobes read hot.
      const hotness = Math.min(1, keySpecular * 2.6 + fresnel * 0.24);
      const colour = mix(PEACH, HOT, hotness);

      const edge = Math.min(1, ((1 - d) * radius) / 1.2);
      pixels[offset] = Math.round(colour[0]);
      pixels[offset + 1] = Math.round(colour[1]);
      pixels[offset + 2] = Math.round(colour[2]);
      pixels[offset + 3] = Math.round(alpha * edge * 255);
    }
  }
  return pixels;
}

function writePam(path: string, pixels: Uint8Array): void {
  const header = Buffer.from(
    `P7\nWIDTH ${SIZE}\nHEIGHT ${SIZE}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
    "ascii",
  );
  NodeFS.writeFileSync(path, Buffer.concat([header, Buffer.from(pixels)]));
}

function toWebp(pamPath: string, webpPath: string): void {
  NodeChildProcess.execFileSync(
    "magick",
    [pamPath, "-define", "webp:method=6", "-quality", "92", "-depth", "8", "-strip", webpPath],
    { cwd: repoRoot, stdio: "pipe" },
  );
}

function main(): void {
  NodeFS.mkdirSync(outputDir, { recursive: true });
  const staging = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-hero-"));

  const layers = [
    ["hero-orb-body", shadeBody()],
    ["hero-orb-glass", shadeGlass()],
  ] as const;

  for (const [name, pixels] of layers) {
    const pamPath = NodePath.join(staging, `${name}.pam`);
    const webpPath = NodePath.join(outputDir, `${name}.webp`);
    writePam(pamPath, pixels);
    toWebp(pamPath, webpPath);
    const size = NodeFS.statSync(webpPath).size;
    console.log(`${NodePath.relative(repoRoot, webpPath)}  ${(size / 1024).toFixed(1)} KiB`);
  }

  NodeFS.rmSync(staging, { recursive: true, force: true });
}

main();

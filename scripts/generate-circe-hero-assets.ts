#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This small raster export CLI is intentionally a synchronous ImageMagick boundary.

/**
 * Render the welcome hero's orb layers.
 *
 * The hero uses two baked transparent layers rather than reproducing a rendered
 * sphere with radial shader ramps, and the ribbon mesh is composited between
 * them so the strands read as passing through the object.
 *
 *   hero-orb-body.png   warm copper-brown volume, internal tonal variation,
 *                       faint suspended specks, no page glow
 *   hero-orb-shell.png  luminous rim, shell glow, one highlight streak, bloom
 *
 * Both layers place the sphere at HERO_ASSET_SPHERE_SCALE of the half-image so
 * the shell has margin to bloom outward past the silhouette without being
 * clipped. The Skia components scale by the same constant.
 *
 * Asset generation alone is not enough to make this look premium, so the
 * shading is art-directed rather than physical:
 *   - no hard terminator. An earlier revision multiplied the body by a
 *     directional falloff down to 0.24, which produced a planet-like dark side.
 *     The floor is now 0.45 so the shadow side stays warm brown.
 *   - no round specular hotspot. The single highlight is an anisotropic streak,
 *     which is what reads as studio lighting rather than a shiny ball.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const outputDir = NodePath.join(repoRoot, "apps/mobile/assets/circe");
const SIZE = 1024;

/** Sphere radius as a fraction of the half-image. Must match heroTokens. */
const SPHERE_SCALE = 0.93;

type Rgb = readonly [number, number, number];

/** Body ramp: deep brown through warm brown and copper to peach-copper. */
const DEEP_BROWN: Rgb = [74, 47, 36];
const WARM_BROWN: Rgb = [110, 70, 54];
const COPPER: Rgb = [185, 122, 93];
const PEACH_COPPER: Rgb = [234, 194, 164];

/** Shell: copper glow through shell peach to the hot edge. */
const SHELL_COPPER: Rgb = [231, 177, 142];
const SHELL_PEACH: Rgb = [245, 216, 193];
const SHELL_HOT: Rgb = [255, 241, 228];

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

function hash01(index: number, salt: number): number {
  const value = Math.sin(index * 91.7 + salt * 233.1) * 43758.5453;
  return value - Math.floor(value);
}

/** Key light: upper left and in front. Fill: lower right, warm and weak. */
const KEY = normalize([-0.5, -0.58, 0.64]);
const FILL = normalize([0.74, 0.42, 0.52]);

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Deterministic suspended specks, baked into the body. */
const SPECKS = Array.from({ length: 18 }, (_, index) => {
  const angle = hash01(index, 71) * Math.PI * 2;
  const distance = Math.sqrt(hash01(index, 72)) * 0.78;
  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    radius: 0.0016 + hash01(index, 73) * 0.0034,
    strength: 0.22 + hash01(index, 74) * 0.4,
  };
});

function bodyColor(ux: number, uy: number, normalZ: number): Rgb {
  const key = Math.max(dot([ux, uy, normalZ], KEY), 0);
  const fill = Math.max(dot([ux, uy, normalZ], FILL), 0);

  let colour = mix(DEEP_BROWN, WARM_BROWN, smoothstep(0, 0.55, key));
  colour = mix(colour, COPPER, smoothstep(0.3, 0.82, key));
  colour = mix(colour, PEACH_COPPER, smoothstep(0.62, 1, key) * 0.8);

  // Warm fill from the opposite side, so the shadow side is lit too.
  colour = mix(colour, WARM_BROWN, fill * 0.3);

  // Broad interior light pooling off-centre, giving the volume depth.
  const gx = ux + 0.22;
  const gy = uy - 0.16;
  colour = mix(colour, COPPER, Math.exp(-((gx * gx + gy * gy) / 0.34)) * 0.22);

  // Soft directional falloff with a high floor: keeps a sense of form without
  // the hard planet terminator.
  const shade = 0.45 + 0.55 * key ** 0.8;
  // Very mild limb darkening for volume. No fresnel here; that belongs to the
  // shell layer.
  const limb = 0.86 + 0.14 * normalZ;
  const scale = shade * limb;
  return [colour[0] * scale, colour[1] * scale, colour[2] * scale];
}

function shadeBody(): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const radius = (SIZE / 2) * SPHERE_SCALE;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const ux = (x + 0.5 - SIZE / 2) / radius;
      const uy = (y + 0.5 - SIZE / 2) / radius;
      const d = Math.hypot(ux, uy);
      if (d >= 1) continue;

      const normalZ = Math.sqrt(Math.max(0, 1 - d * d));
      let colour = bodyColor(ux, uy, normalZ);

      // Baked specks. Faint, soft, and few: this is suspended dust in warm
      // light, not noise.
      for (const speck of SPECKS) {
        const dx = ux - speck.x;
        const dy = uy - speck.y;
        const falloff = Math.exp(-((dx * dx + dy * dy) / (speck.radius * speck.radius)));
        if (falloff < 0.01) continue;
        colour = mix(colour, PEACH_COPPER, falloff * speck.strength);
      }

      const edge = Math.min(1, ((1 - d) * radius) / 1.2);
      pixels[offset] = Math.min(255, Math.round(colour[0]));
      pixels[offset + 1] = Math.min(255, Math.round(colour[1]));
      pixels[offset + 2] = Math.min(255, Math.round(colour[2]));
      pixels[offset + 3] = Math.round(edge * 255);
    }
  }
  return pixels;
}

function shadeShell(): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const radius = (SIZE / 2) * SPHERE_SCALE;
  // The face stays nearly clear so the interior mesh reads through it.
  const faceTint = 0.01;

  // The single highlight streak, elongated along a diagonal so it reads as
  // studio lighting rather than a round specular dot.
  const streakAngle = -0.62;
  const streakCos = Math.cos(streakAngle);
  const streakSin = Math.sin(streakAngle);
  const streakX = -0.3;
  const streakY = -0.34;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const ux = (x + 0.5 - SIZE / 2) / radius;
      const uy = (y + 0.5 - SIZE / 2) / radius;
      const d = Math.hypot(ux, uy);
      // Allow the bloom to extend past the silhouette into the image margin.
      if (d >= 1 / SPHERE_SCALE) continue;

      const inside = d < 1;
      const normalZ = inside ? Math.sqrt(Math.max(0, 1 - d * d)) : 0;

      // Rim, biased so the shell is stronger top-left, top and right rather
      // than uniform all the way round.
      const directionBias = Math.min(
        1,
        0.42 + 0.42 * Math.max(0, -uy) + 0.34 * Math.max(0, ux) + 0.18 * Math.max(0, -ux),
      );
      const rim = inside ? (1 - normalZ) ** 2.8 * directionBias : 0;

      // Narrow inner shell transition, just inside the rim. A wide one reads as
      // a second ring and hazes the whole face.
      const inner = inside ? smoothstep(0.78, 0.96, d) * (1 - smoothstep(0.96, 1, d)) * 0.08 : 0;

      // Outward bloom past the silhouette. The falloff must reach zero well
      // inside the image margin: an earlier, much wider sigma stayed near full
      // strength across the whole margin, which rendered as a solid opaque
      // donut around the sphere rather than a glow.
      const bloomDistance = (d - 1) / (0.03 / SPHERE_SCALE);
      const bloom = inside ? 0 : Math.exp(-(bloomDistance * bloomDistance)) * 0.2;

      const rx = (ux - streakX) * streakCos + (uy - streakY) * streakSin;
      const ry = -(ux - streakX) * streakSin + (uy - streakY) * streakCos;
      const streak = inside ? Math.exp(-((rx * rx) / 0.028 + (ry * ry) / 0.0022)) : 0;

      const alpha = Math.min(1, faceTint + rim * 1.15 + inner + bloom + streak * 0.7);

      // Rim and bloom read peach; the streak reads hot.
      let colour = mix(SHELL_COPPER, SHELL_PEACH, Math.min(1, rim * 1.4 + inner * 2));
      colour = mix(colour, SHELL_HOT, Math.min(1, streak * 1.6));

      const edge = Math.min(1, ((1 / SPHERE_SCALE - d) * radius) / 1.2);
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

function toPng(pamPath: string, pngPath: string): void {
  NodeChildProcess.execFileSync(
    "magick",
    [pamPath, "-define", "png:compression-level=9", "-depth", "8", "-strip", pngPath],
    { cwd: repoRoot, stdio: "pipe" },
  );
}

function main(): void {
  NodeFS.mkdirSync(outputDir, { recursive: true });
  const staging = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-hero-"));

  const layers = [
    ["hero-orb-body", shadeBody()],
    ["hero-orb-shell", shadeShell()],
  ] as const;

  for (const [name, pixels] of layers) {
    const pamPath = NodePath.join(staging, `${name}.pam`);
    const pngPath = NodePath.join(outputDir, `${name}.png`);
    writePam(pamPath, pixels);
    toPng(pamPath, pngPath);
    const size = NodeFS.statSync(pngPath).size;
    console.log(`${NodePath.relative(repoRoot, pngPath)}  ${(size / 1024).toFixed(1)} KiB`);
  }

  NodeFS.rmSync(staging, { recursive: true, force: true });
}

main();

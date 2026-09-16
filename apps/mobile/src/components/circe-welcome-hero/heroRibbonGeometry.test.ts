import { describe, expect, it } from "vite-plus/test";

import {
  buildFilamentPoints,
  bundleHalfWidth,
  lensWarp,
  sampleCenterline,
  type RibbonPoint,
} from "./heroRibbonGeometry";

const WIDTH = 393;
const HEIGHT = 300;
const STEPS = 12;

const CONTROL: ReadonlyArray<readonly [number, number]> = [
  [-0.12, 0.6],
  [0.1, 0.5],
  [0.3, 0.44],
  [0.5, 0.46],
  [0.68, 0.53],
  [0.86, 0.56],
  [1.12, 0.44],
];

function samples() {
  return sampleCenterline(CONTROL, WIDTH, HEIGHT, STEPS);
}

function distance(a: RibbonPoint, b: RibbonPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("sampleCenterline", () => {
  it("starts at the first control point and passes through every one", () => {
    const points = samples();
    CONTROL.forEach((control, index) => {
      const sample = points[index * STEPS];
      expect(sample).toBeDefined();
      expect(sample?.x).toBeCloseTo(control[0] * WIDTH, 6);
      expect(sample?.y).toBeCloseTo(control[1] * HEIGHT, 6);
    });
  });

  it("attaches unit normals, perpendicular to the local tangent", () => {
    const points = samples();
    points.forEach((sample, index) => {
      expect(Math.hypot(sample.nx, sample.ny)).toBeCloseTo(1, 6);
      const previous = points[Math.max(0, index - 1)];
      const next = points[Math.min(points.length - 1, index + 1)];
      if (previous === undefined || next === undefined) return;
      const tx = next.x - previous.x;
      const ty = next.y - previous.y;
      const tangentLength = Math.hypot(tx, ty) || 1;
      // Normal must be orthogonal to the tangent.
      expect((sample.nx * tx + sample.ny * ty) / tangentLength).toBeCloseTo(0, 6);
    });
  });

  it("mostly monotonic in x, so the ribbon never doubles back on itself", () => {
    const points = samples();
    let reversals = 0;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      if (previous === undefined || current === undefined) continue;
      if (current.x < previous.x - 1e-9) reversals += 1;
    }
    expect(reversals).toBe(0);
  });
});

describe("buildFilamentPoints", () => {
  it("keeps adjacent strands exactly the bundle-width apart, on the normal", () => {
    // This is the parallelism guarantee: separation is |offsetA - offsetB|
    // times the half-width, at every sample, for any curve shape. Offsetting in
    // raw Y instead would only hold where the curve is horizontal.
    const points = samples();
    const halfWidth = (x: number) => bundleHalfWidth(x, WIDTH / 2, 84, 13, 62);

    const outer = buildFilamentPoints(points, 1, halfWidth);
    const inner = buildFilamentPoints(points, 0, halfWidth);
    const opposite = buildFilamentPoints(points, -1, halfWidth);

    outer.forEach((point, index) => {
      const middle = inner[index];
      const other = opposite[index];
      const sample = points[index];
      if (middle === undefined || other === undefined || sample === undefined) return;
      expect(distance(point, middle)).toBeCloseTo(halfWidth(sample.x), 5);
      expect(distance(point, other)).toBeCloseTo(halfWidth(sample.x) * 2, 5);
    });
  });

  it("places strands exactly parallel when the bundle width is constant", () => {
    const points = samples();
    const constant = () => 40;
    const a = buildFilamentPoints(points, 1, constant);
    const b = buildFilamentPoints(points, -1, constant);

    // With a constant half-width every filament is a pure normal offset of one
    // shared curve, so the step directions must agree.
    //
    // They are not bit-identical: each sample carries its own normal, and the
    // normal rotates slightly between adjacent samples, so the direction cosine
    // sits a few parts per million below 1. That residue shrinks with the
    // sampling step; it is discretization, not drift between strands. The exact
    // guarantee is the perpendicular-separation test above.
    for (let index = 1; index < points.length; index += 1) {
      const a0 = a[index - 1];
      const a1 = a[index];
      const b0 = b[index - 1];
      const b1 = b[index];
      if (a0 === undefined || a1 === undefined || b0 === undefined || b1 === undefined) continue;
      const ax = a1.x - a0.x;
      const ay = a1.y - a0.y;
      const bx = b1.x - b0.x;
      const by = b1.y - b0.y;
      const alen = Math.hypot(ax, ay) || 1;
      const blen = Math.hypot(bx, by) || 1;
      const cosine = (ax / alen) * (bx / blen) + (ay / alen) * (by / blen);
      expect(cosine).toBeGreaterThan(0.9999);
    }
  });

  it("never crosses strands over", () => {
    const points = samples();
    const halfWidth = (x: number) => bundleHalfWidth(x, WIDTH / 2, 84, 13, 62);
    const offsets = [-0.5, -0.25, 0, 0.25, 0.5];
    const strands = offsets.map((offset) => buildFilamentPoints(points, offset, halfWidth));

    for (let index = 0; index < points.length; index += 1) {
      const sample = points[index];
      if (sample === undefined) continue;
      // Project each strand onto the sample normal: the projections must stay
      // strictly ordered, which is what "parallel, non-crossing" means here.
      const projections = strands.map((strand) => {
        const point = strand[index];
        if (point === undefined) return Number.NaN;
        return (point.x - sample.x) * sample.nx + (point.y - sample.y) * sample.ny;
      });
      for (let s = 1; s < projections.length; s += 1) {
        const previous = projections[s - 1];
        const current = projections[s];
        if (previous === undefined || current === undefined) continue;
        expect(current).toBeGreaterThan(previous);
      }
    }
  });
});

describe("bundleHalfWidth", () => {
  it("is narrowest at the sphere and widens toward the edges", () => {
    const centerX = WIDTH / 2;
    const atCentre = bundleHalfWidth(centerX, centerX, 84, 13, 62);
    const atEdge = bundleHalfWidth(0, centerX, 84, 13, 62);
    expect(atCentre).toBe(13);
    expect(atEdge).toBeGreaterThan(atCentre);
    expect(atEdge).toBeLessThanOrEqual(62);
  });
});

describe("lensWarp", () => {
  it("pinches toward the optical axis, strongest at the centre", () => {
    const centerX = WIDTH / 2;
    const centerY = HEIGHT * 0.46;
    const radius = 84;

    const atCentre = lensWarp(centerX, centerY + 30, centerX, centerY, radius, 0.4);
    const atRim = lensWarp(centerX + radius, centerY + 30, centerX, centerY, radius, 0.4);
    const outside = lensWarp(centerX + radius * 1.5, centerY + 30, centerX, centerY, radius, 0.4);

    // At the middle of the glass the offset shrinks by the full strength.
    expect(atCentre.y).toBeCloseTo(centerY + 30 * 0.6, 5);
    // At the rim there is no depth, so no pinch.
    expect(atRim.y).toBeCloseTo(centerY + 30, 5);
    // Beyond the sphere the sample is left alone.
    expect(outside.y).toBeCloseTo(centerY + 30, 5);
  });

  it("never moves a point across the axis", () => {
    const centerX = WIDTH / 2;
    const centerY = HEIGHT * 0.46;
    const radius = 84;
    for (let dx = -radius; dx <= radius; dx += 8) {
      const warped = lensWarp(centerX + dx, centerY + 40, centerX, centerY, radius, 0.4);
      expect(warped.y).toBeGreaterThan(centerY);
    }
  });
});

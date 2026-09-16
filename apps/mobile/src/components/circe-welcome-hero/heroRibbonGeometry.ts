/**
 * Ribbon geometry for the Circe welcome hero.
 *
 * This module is deliberately free of Skia and React so the shape can be
 * reasoned about and tested directly.
 *
 * The ribbon is a woven surface, not a set of independent lines: there is one
 * art-directed centreline, and every filament is an offset from it along the
 * curve's own perpendicular. That is what keeps the strands locally parallel
 * through every bend. Offsetting in plain Y instead, which is what an earlier
 * revision did, makes the strands drift apart wherever the curve is not
 * horizontal and destroys the woven read.
 *
 * Nothing here is time-dependent. See `HERO_MOTION`: the geometry is frozen and
 * animation happens in colour and in a rigid transform, so no loop seam can
 * exist.
 */

export interface RibbonSample {
  readonly x: number;
  readonly y: number;
  /** Unit normal, pointing along the direction filaments are offset. */
  readonly nx: number;
  readonly ny: number;
}

export interface RibbonPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Uniform Catmull-Rom evaluation over a segment between p1 and p2.
 * Endpoints are duplicated by the caller so the curve passes through every
 * control point.
 */
function catmullRom(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  t: number,
): readonly [number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    0.5 *
    (2 * p1[0] +
      (-p0[0] + p2[0]) * t +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
  const y =
    0.5 *
    (2 * p1[1] +
      (-p0[1] + p2[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
  return [x, y];
}

/**
 * Sample the centreline and attach a unit normal to every sample.
 *
 * `controlPoints` are in hero-normalized coordinates, so x = 0 is the left edge
 * and x = 1 the right. Values outside that range are expected: the ribbon is
 * deliberately oversized (and clipped by the canvas) so the mesh reaches past
 * both edges and "dominates the composition".
 */
export function sampleCenterline(
  controlPoints: ReadonlyArray<readonly [number, number]>,
  width: number,
  height: number,
  stepsPerSegment: number,
): RibbonSample[] {
  if (controlPoints.length < 2) {
    throw new Error("A centreline needs at least two control points.");
  }

  const scaled = controlPoints.map(
    ([x, y]) => [x * width, y * height] as readonly [number, number],
  );
  const at = (index: number): readonly [number, number] => {
    const clamped = Math.min(scaled.length - 1, Math.max(0, index));
    return scaled[clamped] as readonly [number, number];
  };

  const raw: Array<readonly [number, number]> = [];
  const segments = scaled.length - 1;
  for (let segment = 0; segment < segments; segment += 1) {
    const p0 = at(segment - 1);
    const p1 = at(segment);
    const p2 = at(segment + 1);
    const p3 = at(segment + 2);
    const last = segment === segments - 1;
    const steps = last ? stepsPerSegment : stepsPerSegment - 1;
    for (let step = 0; step <= steps; step += 1) {
      raw.push(catmullRom(p0, p1, p2, p3, step / stepsPerSegment));
    }
  }

  // Central-difference tangents, so the normals are smooth along the whole
  // curve rather than stepping at segment joins.
  return raw.map((point, index) => {
    const previous = raw[Math.max(0, index - 1)] as readonly [number, number];
    const next = raw[Math.min(raw.length - 1, index + 1)] as readonly [number, number];
    const tx = next[0] - previous[0];
    const ty = next[1] - previous[1];
    const length = Math.hypot(tx, ty) || 1;
    return {
      x: point[0],
      y: point[1],
      nx: -ty / length,
      ny: tx / length,
    };
  });
}

/**
 * Bundle half-width at a given x.
 *
 * The mesh contracts around the sphere and fans out toward the edges, which is
 * what makes it read as a surface converging on the object rather than a band
 * of constant thickness.
 */
export function bundleHalfWidth(
  x: number,
  centerX: number,
  radius: number,
  minHalfWidth: number,
  maxHalfWidth: number,
): number {
  const distance = Math.abs(x - centerX) / radius;
  return minHalfWidth + (maxHalfWidth - minHalfWidth) * smoothstep(0.7, 2.4, distance);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Refraction applied to the copy of the ribbon that passes through the sphere.
 *
 * The bundle is pinched toward the optical axis in proportion to how deep the
 * sample is inside the glass, so the fan visibly narrows through the object
 * instead of being merely clipped by it.
 */
export function lensWarp(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  radius: number,
  strength: number,
): RibbonPoint {
  const normalizedX = Math.min(1, Math.max(-1, (x - centerX) / radius));
  const depth = Math.sqrt(Math.max(0, 1 - normalizedX * normalizedX));
  return { x, y: centerY + (y - centerY) * (1 - strength * depth) };
}

/**
 * Build one filament by walking the centreline and stepping along its normal.
 *
 * `offset` is in the range -1..1, where 0 is the centreline itself. Because the
 * step is along the normal and the shared centreline is identical for every
 * filament, adjacent strands keep a constant perpendicular separation of
 * `|offsetA - offsetB| * halfWidth` for the whole length of the ribbon.
 */
export function buildFilamentPoints(
  samples: ReadonlyArray<RibbonSample>,
  offset: number,
  halfWidthAt: (x: number) => number,
  warp?: (point: RibbonPoint) => RibbonPoint,
): RibbonPoint[] {
  return samples.map((sample) => {
    const halfWidth = halfWidthAt(sample.x);
    const point = {
      x: sample.x + sample.nx * offset * halfWidth,
      y: sample.y + sample.ny * offset * halfWidth,
    };
    return warp ? warp(point) : point;
  });
}

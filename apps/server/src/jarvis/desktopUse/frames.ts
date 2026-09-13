import type { DesktopUseDisplay } from "@t3tools/contracts";
import { PNG } from "pngjs";
import { readPngSize } from "./parsers.ts";

/** Frames use the native pointer grid, so Retina/compositor scaling cannot shift a click. */
export function normalizeFrame(
  bytes: Uint8Array,
  display: DesktopUseDisplay,
  displays: ReadonlyArray<DesktopUseDisplay>,
  area: "desktop" | "display",
): Uint8Array {
  if (display.width * display.height > 64_000_000)
    throw new Error("Display exceeds the frame size limit");
  const size = readPngSize(bytes);
  if (!size || size.width * size.height > 64_000_000 || bytes.length > 64_000_000)
    throw new Error("Invalid or oversized desktop PNG");
  const png = PNG.sync.read(Buffer.from(bytes));
  const left = area === "display" ? display.x : Math.min(...displays.map((d) => d.x));
  const top = area === "display" ? display.y : Math.min(...displays.map((d) => d.y));
  const width =
    area === "display" ? display.width : Math.max(...displays.map((d) => d.x + d.width)) - left;
  const height =
    area === "display" ? display.height : Math.max(...displays.map((d) => d.y + d.height)) - top;
  const scaleX = png.width / width,
    scaleY = png.height / height;
  if (!Number.isFinite(scaleX) || scaleX <= 0 || Math.abs(scaleX - scaleY) > 0.01)
    throw new Error("Capture geometry does not match the display catalog");
  if (area === "display" && png.width === display.width && png.height === display.height)
    return bytes;
  if (
    area === "desktop" &&
    left === display.x &&
    top === display.y &&
    png.width === display.width &&
    png.height === display.height
  )
    return bytes;
  const out = new PNG({ width: display.width, height: display.height });
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const sourceX = Math.min(png.width - 1, Math.floor((display.x - left + x + 0.5) * scaleX));
      const sourceY = Math.min(png.height - 1, Math.floor((display.y - top + y + 0.5) * scaleY));
      if (sourceX < 0 || sourceY < 0) throw new Error("Display is outside the captured desktop");
      const from = (sourceY * png.width + sourceX) * 4,
        to = (y * out.width + x) * 4;
      out.data[to] = png.data[from]!;
      out.data[to + 1] = png.data[from + 1]!;
      out.data[to + 2] = png.data[from + 2]!;
      out.data[to + 3] = png.data[from + 3]!;
    }
  return PNG.sync.write(out);
}

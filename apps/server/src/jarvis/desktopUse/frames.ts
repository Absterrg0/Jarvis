import type { DesktopUseDisplay } from "@t3tools/contracts";
import { PNG } from "pngjs";
import { readPngSize } from "./parsers.ts";

/**
 * Frame safety budgets. The decoded RGBA bytes of the input and output are the
 * real memory cost, so they are bounded together before any decode happens.
 */
const MAX_FRAME_PIXELS = 33_177_600; // 7680x4320, the largest desktop panel we accept.
const MAX_ENCODED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_FRAME_BYTES = 192 * 1024 * 1024;

/** Yield between scanline batches so a large resample cannot starve the loop. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const decodePng = (bytes: Uint8Array): Promise<PNG> =>
  new Promise((resolve, reject) => {
    // pngjs inflates through zlib streams, keeping the heavy work off the main
    // stack; the promise lets the caller await it in an Effect.
    new PNG().parse(Buffer.from(bytes), (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });

const encodePng = (png: PNG): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    png.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    png.on("error", reject);
    png.on("end", () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    png.pack();
  });

/** Frames use the native pointer grid, so Retina/compositor scaling cannot shift a click. */
export async function normalizeFrame(
  bytes: Uint8Array,
  display: DesktopUseDisplay,
  displays: ReadonlyArray<DesktopUseDisplay>,
  area: "desktop" | "display",
): Promise<Uint8Array> {
  if (display.width * display.height > MAX_FRAME_PIXELS)
    throw new Error("Display exceeds the frame size limit");
  const size = readPngSize(bytes);
  if (
    !size ||
    size.width * size.height > MAX_FRAME_PIXELS ||
    bytes.length > MAX_ENCODED_FRAME_BYTES
  )
    throw new Error("Invalid or oversized desktop PNG");
  if ((size.width * size.height + display.width * display.height) * 4 > MAX_DECODED_FRAME_BYTES)
    throw new Error("Decoded capture exceeds the frame memory budget");
  const png = await decodePng(bytes);
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
  for (let y = 0; y < out.height; y++) {
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
    if ((y & 255) === 255) await yieldToEventLoop();
  }
  return encodePng(out);
}

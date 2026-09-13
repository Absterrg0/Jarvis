import { expect, it } from "vite-plus/test";
import { PNG } from "pngjs";
import { normalizeFrame } from "./frames.ts";

it("normalizes Retina pixels and a negative-origin selected monitor to the pointer grid", async () => {
  const display = { id: "left", x: -2, y: -1, width: 2, height: 2, scale: 2, primary: false };
  const other = { ...display, id: "right", x: 0, primary: true };
  const png = new PNG({ width: 8, height: 4 });
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      png.data[i] = x < 4 ? 255 : 0;
      png.data[i + 1] = x >= 4 ? 255 : 0;
      png.data[i + 3] = 255;
    }
  const normalized = await normalizeFrame(
    PNG.sync.write(png),
    display,
    [display, other],
    "desktop",
  );
  const frame = PNG.sync.read(Buffer.from(normalized));
  expect([frame.width, frame.height]).toEqual([2, 2]);
  for (let i = 0; i < frame.data.length; i += 4)
    expect([...frame.data.subarray(i, i + 4)]).toEqual([255, 0, 0, 255]);
});
it("rejects mismatched geometry and truncated PNG data", async () => {
  const display = { id: "main", x: 0, y: 0, width: 10, height: 10, scale: 1, primary: true };
  const png = PNG.sync.write(new PNG({ width: 20, height: 10 }));
  await expect(normalizeFrame(png, display, [display], "display")).rejects.toThrow("geometry");
  await expect(
    normalizeFrame(png.subarray(0, 33), display, [display], "display"),
  ).rejects.toThrow();
});
it("rejects a capture whose decoded buffers exceed the memory budget before decoding", async () => {
  const display = { id: "8k", x: 0, y: 0, width: 8000, height: 4000, scale: 1, primary: true };
  const header = new Uint8Array(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.set([0, 0, 0, 13], 8);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(header.buffer);
  view.setUint32(16, 8000, false);
  view.setUint32(20, 4000, false);
  await expect(normalizeFrame(header, display, [display], "display")).rejects.toThrow("budget");
});

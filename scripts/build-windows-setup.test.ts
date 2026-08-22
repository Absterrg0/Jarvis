// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makensisVerbosityFlag, pruneRuntimePayload } from "./build-windows-setup.ts";

describe("Windows setup compiler invocation", () => {
  it("uses the platform-specific makensis verbosity flag", () => {
    expect(makensisVerbosityFlag("win32")).toBe("/V2");
    expect(makensisVerbosityFlag("linux")).toBe("-V2");
  });

  it("prunes UI packages and source-only files from every deployed t3 package", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jarvis-runtime-prune-"));
    const exists = async (path: string) => Boolean(await NodeFSP.stat(path).catch(() => undefined));
    const writeJson = async (path: string, value: unknown) => {
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
    };
    try {
      await writeJson(NodePath.join(root, "package.json"), { name: "t3" });
      await writeJson(NodePath.join(root, "node_modules", "@t3tools", "web", "package.json"), {
        name: "@t3tools/web",
      });
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "@t3tools", "web", "client.js"),
        "ui",
      );
      await writeJson(NodePath.join(root, "node_modules", "t3", "package.json"), {
        name: "t3",
      });
      await NodeFSP.mkdir(NodePath.join(root, "src"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "dist", "client"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "dist", "server"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "node_modules", "t3", "src"), {
        recursive: true,
      });
      await NodeFSP.mkdir(NodePath.join(root, "node_modules", "t3", "dist", "client"), {
        recursive: true,
      });
      await NodeFSP.mkdir(NodePath.join(root, "node_modules", "t3", "dist", "server"), {
        recursive: true,
      });
      await NodeFSP.writeFile(NodePath.join(root, "src", "source.ts"), "source");
      await NodeFSP.writeFile(NodePath.join(root, "dist", "client", "client.js"), "client");
      await NodeFSP.writeFile(NodePath.join(root, "dist", "server", "server.js"), "server");
      await NodeFSP.writeFile(NodePath.join(root, "dist", "server", "server.js.map"), "map");
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "t3", "src", "source.ts"),
        "source",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "t3", "dist", "client", "client.js"),
        "client",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "t3", "dist", "server", "server.js"),
        "server",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "t3", "dist", "server", "server.js.map"),
        "map",
      );
      await writeJson(NodePath.join(root, "node_modules", "other", "package.json"), {
        name: "other",
      });
      await NodeFSP.mkdir(NodePath.join(root, "node_modules", "other", "dist"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, "node_modules", "other", "dist", "other.js.map"),
        "keep",
      );

      await pruneRuntimePayload(root);

      expect(await exists(NodePath.join(root, "node_modules", "@t3tools", "web"))).toBe(false);
      expect(await exists(NodePath.join(root, "src"))).toBe(false);
      expect(await exists(NodePath.join(root, "dist", "client"))).toBe(false);
      expect(await exists(NodePath.join(root, "dist", "server", "server.js.map"))).toBe(false);
      expect(await exists(NodePath.join(root, "dist", "server", "server.js"))).toBe(true);
      expect(await exists(NodePath.join(root, "node_modules", "t3", "src"))).toBe(false);
      expect(await exists(NodePath.join(root, "node_modules", "t3", "dist", "client"))).toBe(false);
      expect(
        await exists(NodePath.join(root, "node_modules", "t3", "dist", "server", "server.js.map")),
      ).toBe(false);
      expect(
        await exists(NodePath.join(root, "node_modules", "t3", "dist", "server", "server.js")),
      ).toBe(true);
      expect(
        await exists(NodePath.join(root, "node_modules", "other", "dist", "other.js.map")),
      ).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

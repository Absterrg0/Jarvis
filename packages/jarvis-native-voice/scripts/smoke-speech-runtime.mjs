// oxlint-disable t3code/no-global-process-runtime -- standalone hardware smoke command.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);
const cpal = require("node-cpal");
const resourceRoot = NodePath.resolve(
  process.argv[2] ?? NodePath.resolve(import.meta.dirname, "../resources"),
);
const projectRoot = NodePath.resolve(import.meta.dirname, "../../../apps/desktop/pipecat");
const launcher = NodePath.resolve(projectRoot, "scripts/launch.py");

const hosts = cpal.getHosts();
if (!Array.isArray(hosts)) throw new Error("node-cpal did not load its native audio backend.");

const result = NodeChildProcess.spawnSync(
  "uv",
  ["run", "--project", projectRoot, "python", launcher, "--self-test"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      JARVIS_PIPECAT_MODEL_ROOT: NodePath.resolve(resourceRoot, "parakeet"),
      JARVIS_PIPECAT_KOKORO_ROOT: NodePath.resolve(resourceRoot, "kokoro"),
    },
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Production Pipecat smoke failed: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

console.log(
  `Speech runtime smoke passed (${hosts.length} audio host(s), production Pipecat capture and speech).`,
);

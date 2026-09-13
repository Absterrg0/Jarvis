import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import { test } from "vite-plus/test";
import { checkNpmPublish } from "./check-npm-publish.mjs";

const manifest = {
  name: "@absterrg0/circe",
  version: "0.0.52",
  repository: { type: "git", url: "https://github.com/Absterrg0/circe" },
};
const env = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-request-secret",
};

test("rejects npm's successful dry run when trusted authentication failed", async () => {
  await NodeAssert.rejects(
    checkNpmPublish({
      manifest,
      env,
      runNpm: () => ({
        status: 0,
        stdout: "",
        stderr:
          "npm verbose oidc Failed token exchange request with body message: OIDC token exchange error - package not found\nnpm warn This command requires you to be logged in (dry-run)",
      }),
    }),
    /OIDC token exchange error - package not found/,
  );
});

test("uses native npm OIDC on a disposable package without publishing", async () => {
  let directory;
  await checkNpmPublish({
    manifest,
    env,
    runNpm: (args, options) => {
      directory = options.cwd;
      NodeAssert.ok(args.includes("--dry-run"));
      NodeAssert.ok(args.includes("--ignore-scripts"));
      NodeAssert.ok(args.includes("--loglevel=verbose"));
      NodeAssert.equal(
        options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      );
      const pkg = JSON.parse(NodeFS.readFileSync(`${options.cwd}/package.json`, "utf8"));
      NodeAssert.equal(pkg.name, manifest.name);
      NodeAssert.equal(pkg.version, manifest.version);
      NodeAssert.deepEqual(pkg.repository, manifest.repository);
      NodeAssert.equal(pkg.dependencies, undefined);
      return {
        status: 0,
        stdout: "",
        stderr: "npm verbose oidc Successfully retrieved and set token",
      };
    },
  });
  NodeAssert.throws(() => NodeFS.readFileSync(`${directory}/package.json`), /ENOENT/);
});

test("rejects missing workflow permissions before invoking npm", async () => {
  await NodeAssert.rejects(
    checkNpmPublish({
      manifest,
      env: {},
      runNpm: () => {
        NodeAssert.fail("npm must not run without the workflow identity");
      },
    }),
    /id-token: write/,
  );
});

test("fails if the version check fails after successful authentication", async () => {
  await NodeAssert.rejects(
    checkNpmPublish({
      manifest,
      env,
      runNpm: () => ({
        status: 1,
        stdout: "",
        stderr:
          "npm verbose oidc Successfully retrieved and set token\nnpm error You cannot publish over the previously published versions: 0.0.52.",
      }),
    }),
    /previously published versions/,
  );
});

test("does not expose credentials in failure diagnostics", async () => {
  await NodeAssert.rejects(
    checkNpmPublish({
      manifest,
      env,
      runNpm: () => ({
        status: 1,
        stdout: "",
        stderr: `npm verbose oidc failure ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      }),
    }),
    (error) => {
      NodeAssert.ok(!error.message.includes(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN));
      return true;
    },
  );
});

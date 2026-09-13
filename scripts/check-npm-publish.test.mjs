import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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
  await assert.rejects(
    checkNpmPublish({ manifest, env, runNpm: () => ({
      status: 0,
      stdout: "",
      stderr: "npm verbose oidc Failed token exchange request with body message: Unable to authenticate\nnpm warn This command requires you to be logged in (dry-run)",
    }) }),
    /Unable to authenticate/,
  );
});

test("uses native npm OIDC on a disposable package without publishing", async () => {
  let directory;
  await checkNpmPublish({ manifest, env, runNpm: (args, options) => {
    directory = options.cwd;
    assert.ok(args.includes("--dry-run"));
    assert.ok(args.includes("--ignore-scripts"));
    assert.ok(args.includes("--loglevel=verbose"));
    assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
    const pkg = JSON.parse(readFileSync(`${options.cwd}/package.json`, "utf8"));
    assert.equal(pkg.name, manifest.name);
    assert.equal(pkg.version, manifest.version);
    assert.deepEqual(pkg.repository, manifest.repository);
    assert.equal(pkg.dependencies, undefined);
    return { status: 0, stdout: "", stderr: "npm verbose oidc Successfully retrieved and set token" };
  } });
  assert.throws(() => readFileSync(`${directory}/package.json`), /ENOENT/);
});

test("rejects missing workflow permissions before invoking npm", async () => {
  await assert.rejects(checkNpmPublish({ manifest, env: {}, runNpm: () => {
    assert.fail("npm must not run without the workflow identity");
  } }), /id-token: write/);
});

test("fails if the version check fails after successful authentication", async () => {
  await assert.rejects(checkNpmPublish({ manifest, env, runNpm: () => ({
    status: 1, stdout: "", stderr: "npm verbose oidc Successfully retrieved and set token\nnpm error You cannot publish over the previously published versions: 0.0.52.",
  }) }), /previously published versions/);
});

test("does not expose credentials in failure diagnostics", async () => {
  await assert.rejects(checkNpmPublish({ manifest, env, runNpm: () => ({
    status: 1, stdout: "", stderr: `npm verbose oidc failure ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
  }) }), (error) => {
    assert.ok(!error.message.includes(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN));
    return true;
  });
});

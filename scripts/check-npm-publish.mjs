import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// npm's dry run still exchanges OIDC credentials, but returns success without
// them. Require the exchange result as well as the command's exit status.
export async function checkNpmPublish({
  manifest,
  env = process.env,
  runNpm = (args, options) =>
    NodeChildProcess.spawnSync("npm", args, {
      ...options,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    }),
}) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    throw new Error("npm preflight requires GitHub Actions with id-token: write in release.yml.");
  }
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-npm-preflight-"));
  try {
    await NodeFSP.writeFile(
      NodePath.join(directory, "package.json"),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        repository: manifest.repository,
      }),
    );
    const result = runNpm(
      [
        "publish",
        "--dry-run",
        "--ignore-scripts",
        "--access=public",
        "--tag=circe-preflight",
        "--registry=https://registry.npmjs.org/",
        "--loglevel=verbose",
        "--json",
      ],
      { cwd: directory, env },
    );
    const stderr = result.stderr ?? "";
    if (result.status !== 0 || !stderr.includes("oidc Successfully retrieved and set token")) {
      let diagnostic = stderr
        .split("\n")
        .filter((line) => /(?:verbose oidc|npm error|npm warn.*logged in)/.test(line))
        .join("\n");
      for (const [key, value] of Object.entries(env)) {
        if (value && /TOKEN|SECRET|PASSWORD|AUTH/i.test(key))
          diagnostic = diagnostic.replaceAll(value, "[redacted]");
      }
      throw new Error(
        `npm trusted publishing preflight failed for ${manifest.name}.\n${diagnostic || "npm did not confirm an OIDC exchange; check the installed npm version and workflow permissions."}`,
      );
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = JSON.parse(
      await NodeFSP.readFile(new URL("../apps/server/package.json", import.meta.url), "utf8"),
    );
    // Nightlies resolve their version later. Never reject an authentication-only
    // check just because the checked-out package version was already published.
    manifest.version = process.env.RELEASE_VERSION || "0.0.0-circe-preflight";
    console.log(`Checking ${process.env.GITHUB_REPOSITORY} via ${process.env.GITHUB_WORKFLOW_REF}`);
    await checkNpmPublish({ manifest });
    console.log(
      `npm trusted publishing accepted ${manifest.name}@${manifest.version}; nothing was published.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

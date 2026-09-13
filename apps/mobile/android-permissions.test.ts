import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const projectRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const require = NodeModule.createRequire(import.meta.url);
const expoCli = require.resolve("expo/bin/cli");

type IntrospectedExpoConfig = {
  readonly android?: {
    readonly permissions?: ReadonlyArray<string>;
  };
  readonly _internal?: {
    readonly modResults?: {
      readonly android?: {
        readonly manifest?: {
          readonly manifest?: {
            readonly "uses-permission"?: ReadonlyArray<{
              readonly $?: Readonly<Record<string, string>>;
            }>;
          };
        };
      };
    };
  };
};

function readAndroidConfig(): IntrospectedExpoConfig {
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [expoCli, "config", "--type", "introspect", "--json"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, APP_VARIANT: "preview" },
    },
  );
  return JSON.parse(output) as IntrospectedExpoConfig;
}

describe("mobile Android permissions", () => {
  it("keeps RECORD_AUDIO available for Circe push-to-talk", () => {
    const config = readAndroidConfig();
    const recordAudioPermission = config._internal?.modResults?.android?.manifest?.manifest?.[
      "uses-permission"
    ]?.find((permission) => permission.$?.["android:name"] === "android.permission.RECORD_AUDIO");

    expect(config.android?.permissions).toContain("android.permission.RECORD_AUDIO");
    expect(recordAudioPermission).toBeDefined();
    expect(recordAudioPermission?.$?.["tools:node"]).not.toBe("remove");
  });
});

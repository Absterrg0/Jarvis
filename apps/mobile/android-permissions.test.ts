import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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
  const output = execFileSync(
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
  it("keeps RECORD_AUDIO available for Jarvis push-to-talk", () => {
    const config = readAndroidConfig();
    const recordAudioPermission = config._internal?.modResults?.android?.manifest?.manifest?.[
      "uses-permission"
    ]?.find((permission) => permission.$?.["android:name"] === "android.permission.RECORD_AUDIO");

    expect(config.android?.permissions).toContain("android.permission.RECORD_AUDIO");
    expect(recordAudioPermission).toBeDefined();
    expect(recordAudioPermission?.$?.["tools:node"]).not.toBe("remove");
  });
});

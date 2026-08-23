// @effect-diagnostics nodeBuiltinImport:off - this test inspects the packaged-app smoke gate.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

describe("Jarvis Linux startup gate", () => {
  it("uses a real isolated Wayland compositor while requiring renderer presentation", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/jarvis-desktop-linux.yml"),
      "utf8",
    );

    expect(workflow).toContain('smoke_root="$RUNNER_TEMP/jarvis-gui-smoke-home"');
    expect(workflow).toContain(
      'mkdir -p "$smoke_root/t3-home" "$smoke_root/xdg-config" "$smoke_root/xdg-data" "$smoke_root/xdg-cache"',
    );
    expect(workflow).toContain("weston --backend=headless --renderer=pixman");
    expect(workflow).toContain('wayland_runtime="$RUNNER_TEMP/jarvis-wayland-runtime"');
    expect(workflow).toContain('wayland_socket="jarvis-weston"');
    expect(workflow).toContain('chmod 700 "$wayland_runtime"');
    expect(workflow).toContain("inotifywait -q -e create,moved_to");
    expect(workflow).toContain(
      'XDG_RUNTIME_DIR="$wayland_runtime" WAYLAND_DISPLAY="$wayland_socket"',
    );
    expect(workflow).not.toContain("xvfb-run");
    expect(workflow).not.toContain("--headless --ozone-platform");
    expect(workflow).toContain(
      'T3CODE_HOME="$smoke_root/t3-home" XDG_CONFIG_HOME="$smoke_root/xdg-config"',
    );
    expect(workflow).toContain(
      'XDG_DATA_HOME="$smoke_root/xdg-data" XDG_CACHE_HOME="$smoke_root/xdg-cache"',
    );
    expect(workflow).toContain(
      '"$app" --ozone-platform=wayland --no-sandbox --disable-gpu --password-store=basic --jarvis-startup-probe="$probe_file"',
    );
    expect(workflow).toContain("app_pid=$!");
    expect(workflow).toContain("weston_pid=$!");
    expect(workflow).toContain('kill -TERM -- "-$app_pid"');
    expect(workflow).toContain('kill -TERM "$weston_pid"');
    expect(workflow).toContain('cat "$weston_log" >&2 || true');
    expect(workflow).toContain('wait -n "$watcher_pid" "$app_pid"');
    expect(workflow).toContain('receipt.phase !== "main-window-revealed"');
    expect(workflow).toContain("renderer load and window reveal");
  });
});

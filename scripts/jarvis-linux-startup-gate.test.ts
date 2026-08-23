// @effect-diagnostics nodeBuiltinImport:off - this test inspects the packaged-app smoke gate.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

describe("Jarvis Linux startup gate", () => {
  it("uses a real isolated X11 display while requiring renderer presentation", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/jarvis-desktop-linux.yml"),
      "utf8",
    );

    expect(workflow).toContain('smoke_root="$RUNNER_TEMP/jarvis-gui-smoke-home"');
    expect(workflow).toContain(
      'mkdir -p "$smoke_root/t3-home" "$smoke_root/xdg-config" "$smoke_root/xdg-data" "$smoke_root/xdg-cache"',
    );
    expect(workflow).toContain('x_display=":99"');
    expect(workflow).toContain('x_socket="/tmp/.X11-unix/X${x_display#:}"');
    expect(workflow).toContain('xvfb_log="$RUNNER_TEMP/jarvis-xvfb.log"');
    expect(workflow).toContain('openbox_log="$RUNNER_TEMP/jarvis-openbox.log"');
    expect(workflow).toContain('chmod 700 "$smoke_root/xdg-runtime"');
    expect(workflow).toContain("sudo install -d -m 1777 /tmp/.X11-unix");
    expect(workflow).toContain("Refusing to reuse an existing X11 socket");
    expect(workflow).toContain("inotifywait -q -e create,moved_to");
    expect(workflow).toContain('XDG_RUNTIME_DIR="$smoke_root/xdg-runtime" DISPLAY="$x_display"');
    expect(workflow).toContain('setsid Xvfb "$x_display" -screen 0 1280x800x24 -nolisten tcp');
    expect(workflow).toContain("openbox");
    expect(workflow).toContain("x11-utils");
    expect(workflow).toContain("_NET_SUPPORTING_WM_CHECK");
    expect(workflow).not.toContain("WAYLAND");
    expect(workflow).not.toContain("--headless");
    expect(workflow).toContain(
      'T3CODE_HOME="$smoke_root/t3-home" XDG_CONFIG_HOME="$smoke_root/xdg-config"',
    );
    expect(workflow).toContain(
      'XDG_DATA_HOME="$smoke_root/xdg-data" XDG_CACHE_HOME="$smoke_root/xdg-cache"',
    );
    expect(workflow).toContain(
      '"$app" --ozone-platform=x11 --no-sandbox --disable-gpu --password-store=basic --jarvis-startup-probe="$probe_file"',
    );
    expect(workflow).toContain("app_pid=$!");
    expect(workflow).toContain("xvfb_pid=$!");
    expect(workflow).toContain('kill -TERM -- "-$app_pid"');
    expect(workflow).toContain('kill -TERM -- "-$xvfb_pid"');
    expect(workflow).toContain('kill -TERM -- "-$openbox_pid"');
    expect(workflow).toContain('tail -n 200 "$xvfb_log" >&2 || true');
    expect(workflow).toContain('tail -n 200 "$openbox_log" >&2 || true');
    expect(workflow).toContain("xwininfo -root -tree");
    expect(workflow).toContain("Packaged GUI smoke diagnostics; X window tree:");
    expect(workflow).toContain('wait -n "$watcher_pid" "$app_pid"');
    expect(workflow).toContain('receipt.phase !== "main-window-revealed"');
    expect(workflow).toContain("renderer mount and window reveal");
  });
});

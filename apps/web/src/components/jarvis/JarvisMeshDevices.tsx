import type { EnvironmentId } from "@t3tools/contracts";
import { RELAY_DEFAULT_ENABLED_DEVICE_LIMIT } from "@t3tools/contracts/relay";
import { useState } from "react";

import {
  setManagedRelayEnvironmentEnabledCommand,
  useManagedRelayEnvironments,
} from "../../cloud/managedRelayState";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

interface FailedToggle {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
}

/**
 * Lists every device linked to the signed-in account and lets the user turn
 * access on or off. Enabling past the cap turns off the least-recently-used
 * device on the relay, so the list is the source of truth after each change.
 */
export function JarvisMeshDevices() {
  const environments = useManagedRelayEnvironments();
  const setEnabled = useAtomCommand(setManagedRelayEnvironmentEnabledCommand, {
    reportFailure: false,
  });
  const [pendingId, setPendingId] = useState<EnvironmentId | null>(null);
  const [failed, setFailed] = useState<FailedToggle | null>(null);

  if (!environments.accountId) return null;

  const accountId = environments.accountId;
  const devices = environments.data ?? [];
  const enabledCount = devices.filter((env) => env.enabled !== false).length;

  const apply = async (environmentId: EnvironmentId, enabled: boolean) => {
    if (pendingId !== null) return;
    setPendingId(environmentId);
    setFailed(null);
    const result = await setEnabled({ accountId, environmentId, enabled });
    setPendingId(null);
    if (result._tag === "Success") {
      environments.refresh();
    } else {
      setFailed({ environmentId, enabled });
    }
  };

  return (
    <section className="jarvis-device-access">
      <div className="jarvis-section-heading">
        <h3>
          Devices{" "}
          <span className="jarvis-inline-count">
            {enabledCount} of {RELAY_DEFAULT_ENABLED_DEVICE_LIMIT}
          </span>
        </h3>
      </div>
      <p className="jarvis-muted-note">
        Enabled devices can be reached from any device you are signed in to.
      </p>
      {devices.length === 0 ? (
        <p className="jarvis-muted-note">No devices linked yet.</p>
      ) : (
        <div className="jarvis-device-access-list">
          {devices.map((environment) => {
            const enabled = environment.enabled !== false;
            const busy = pendingId === environment.environmentId;
            const rowFailed = failed?.environmentId === environment.environmentId;
            return (
              <div className="jarvis-device-access-row" key={environment.environmentId}>
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="jarvis-device-access-name" tabIndex={0} />}
                  >
                    {environment.label}
                  </TooltipTrigger>
                  <TooltipPopup>{environment.label}</TooltipPopup>
                </Tooltip>
                {rowFailed && failed !== null ? (
                  <button
                    type="button"
                    className="jarvis-text-action"
                    disabled={busy}
                    onClick={() => void apply(environment.environmentId, failed.enabled)}
                  >
                    Retry
                  </button>
                ) : null}
                <Switch
                  size="sm"
                  checked={enabled}
                  disabled={busy}
                  aria-label={`${enabled ? "Disable" : "Enable"} ${environment.label}`}
                  onCheckedChange={(next) => {
                    if (next !== enabled) void apply(environment.environmentId, next);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      {failed ? (
        <p className="jarvis-device-access-error">
          Could not change that device. Check your connection and retry.
        </p>
      ) : null}
      {environments.error ? (
        <p className="jarvis-device-access-error">{environments.error}</p>
      ) : null}
    </section>
  );
}

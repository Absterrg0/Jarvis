import { EnvironmentId } from "@t3tools/contracts";
import { act, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface TestEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: string };
  readonly displayUrl: string | null;
}

const testState = vi.hoisted(() => ({
  environments: [] as TestEnvironment[],
  primaryEnvironmentId: null as EnvironmentId | null,
  primaryEnvironment: null as {
    readonly environmentId: EnvironmentId;
    readonly entry: { readonly target: { readonly _tag: string } };
  } | null,
  cloudPublicConfig: false,
  clerkAuth: { isLoaded: true, isSignedIn: false },
  cloudLink: {
    linked: false,
    managedTunnelActive: false,
    publishAgentActivity: false,
    operationError: null as string | null,
    target: null as { readonly environmentId: EnvironmentId } | null,
    reconcile: vi.fn(),
  },
  connectPairingCommand: Symbol("connectPairing"),
  setEnvironmentLabelCommand: Symbol("setEnvironmentLabel"),
  connectPairing: vi.fn(),
  setEnvironmentLabel: vi.fn(),
}));

vi.mock("../../connection/onboarding", () => ({
  connectPairing: testState.connectPairingCommand,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === testState.connectPairingCommand
      ? testState.connectPairing
      : testState.setEnvironmentLabel,
}));

vi.mock("../../state/server", () => ({
  primaryServerConfigAtom: Symbol("primaryServerConfig"),
  serverEnvironment: { setEnvironmentLabel: testState.setEnvironmentLabelCommand },
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  usePrimaryEnvironment: () => testState.primaryEnvironment,
  usePrimaryEnvironmentId: () => testState.primaryEnvironmentId,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));

vi.mock("../../cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => testState.cloudPublicConfig,
}));

vi.mock("@clerk/react", () => ({ useAuth: () => testState.clerkAuth }));

vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({
  useT3ConnectAuthPrompt: () => ({ openAuthPrompt: vi.fn() }),
}));

vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linked: testState.cloudLink.linked,
    managedTunnelActive: testState.cloudLink.managedTunnelActive,
    publishAgentActivity: testState.cloudLink.publishAgentActivity,
    operationError: testState.cloudLink.operationError,
    reconcileCloudState: testState.cloudLink.reconcile,
    linkState: { target: testState.cloudLink.target },
  }),
}));

vi.mock("../../state/agentSessions", () => ({ agentSessionImport: Symbol("agentSessionImport") }));
vi.mock("../../state/entities", () => ({ readProjects: () => [], useProjects: () => [] }));
vi.mock("../../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../../onboarding/useProjectScans", () => ({ useProjectScans: () => [] }));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => vi.fn() }));

vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { readonly children?: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: (props: {
    readonly checked: boolean;
    readonly onCheckedChange: (checked: boolean) => void;
    readonly ["aria-label"]?: string;
  }) => (
    <input
      type="checkbox"
      aria-label={props["aria-label"]}
      checked={props.checked}
      onChange={(event) => props.onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("../ui/collapsible", () => ({
  Collapsible: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  CollapsiblePanel: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/input", () => ({
  Input: (props: {
    readonly id?: string;
    readonly value?: string;
    readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
    readonly ["aria-label"]?: string;
  }) => (
    <input
      id={props.id}
      aria-label={props["aria-label"]}
      value={props.value ?? ""}
      onChange={props.onChange}
    />
  ),
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/switch", () => ({
  Switch: (props: {
    readonly ["aria-label"]?: string;
    readonly checked?: boolean;
    readonly disabled?: boolean;
    readonly onCheckedChange?: (next: boolean) => void;
  }) => (
    <button
      aria-label={props["aria-label"]}
      aria-pressed={props.checked}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange?.(!props.checked)}
    />
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  TooltipPopup: () => null,
}));
vi.mock("../ui/wizard", () => ({
  WizardPanel: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  WizardSteps: () => null,
  WizardPopup: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  WizardHeader: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(), close: vi.fn(), update: vi.fn() },
}));

import { ConnectionStep, WelcomeWizard } from "./WelcomeWizard";

let renderer: ReactTestRenderer | null = null;

function Harness({
  onContinue,
  localAvailable = false,
}: {
  readonly onContinue: () => void;
  readonly localAvailable?: boolean;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(new Set());
  return (
    <ConnectionStep
      localAvailable={localAvailable}
      autoSelectedComputers={new Set<EnvironmentId>()}
      expandPairingInitially
      selectedIds={selectedIds}
      onSelectionChange={setSelectedIds}
      onToggleEnvironment={(environmentId, checked) =>
        setSelectedIds((current) => {
          const next = new Set(current);
          if (checked) next.add(environmentId);
          else next.delete(environmentId);
          return next;
        })
      }
      onContinue={onContinue}
      onPaired={(environmentId) =>
        setSelectedIds((current) => new Set([...current, environmentId]))
      }
    />
  );
}

function WizardHarness() {
  return <WelcomeWizard localAvailable={false} onDone={() => {}} />;
}

function buttonWithText(text: string) {
  const match = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes(text));
  if (match === undefined) throw new Error(`No button with text ${text}`);
  return match;
}

function pairingUrlInput() {
  const match = renderer!.root
    .findAllByType("input")
    .find((input) => input.props.id === "onboarding-pairing-url");
  if (match === undefined) throw new Error("No pairing URL input");
  return match;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  vi.stubGlobal("document", { activeElement: null, body: {}, getElementById: () => null });
  testState.environments = [];
  testState.primaryEnvironmentId = null;
  testState.primaryEnvironment = null;
  testState.cloudPublicConfig = false;
  testState.clerkAuth = { isLoaded: true, isSignedIn: false };
  testState.cloudLink.linked = false;
  testState.cloudLink.managedTunnelActive = false;
  testState.cloudLink.publishAgentActivity = false;
  testState.cloudLink.operationError = null;
  testState.cloudLink.target = null;
  testState.cloudLink.reconcile.mockReset();
  testState.connectPairing.mockReset();
  testState.setEnvironmentLabel.mockReset();
  renderer = null;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("onboarding direct pairing without cloud or local environments", () => {
  it("offers pairing, selects the paired computer, and enables Continue", async () => {
    const pairedEnvironmentId = EnvironmentId.make("paired-computer");
    testState.connectPairing.mockImplementation(async () => {
      testState.environments = [
        {
          environmentId: pairedEnvironmentId,
          label: "Paired computer",
          connection: { phase: "connected" },
          displayUrl: "https://paired.example.test",
        },
      ];
      return { _tag: "Success", value: pairedEnvironmentId };
    });

    const onContinue = vi.fn();
    await act(async () => {
      renderer = create(<Harness onContinue={onContinue} />);
    });

    // No environments and no cloud: direct pairing is the only way forward.
    expect(buttonWithText("Continue").props.disabled).toBe(true);
    expect(pairingUrlInput()).toBeDefined();

    await act(async () => {
      pairingUrlInput().props.onChange({
        currentTarget: { value: "https://nas.example/pair#token=x" },
      });
    });
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });
    await act(async () => {});

    expect(testState.connectPairing).toHaveBeenCalledWith({
      pairingUrl: "https://nas.example/pair#token=x",
    });
    // The paired environment is present, connected, and selected, so the wizard
    // can leave the connection step.
    expect(buttonWithText("Continue").props.disabled).toBe(false);
  });
});

function deferredPairing() {
  let resolve!: (value: { _tag: "Success"; value: EnvironmentId }) => void;
  const promise = new Promise<{ _tag: "Success"; value: EnvironmentId }>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function checkboxWithLabel(label: string) {
  const match = renderer!.root
    .findAllByType("input")
    .find((input) => input.props.type === "checkbox" && input.props["aria-label"] === label);
  if (match === undefined) throw new Error(`No checkbox labeled ${label}`);
  return match;
}

describe("onboarding device naming", () => {
  it("labels the rename input and waits for the node before it connects", async () => {
    const localId = EnvironmentId.make("this-computer");
    // Node not connected yet: a waiting row explains the missing name field.
    await act(async () => {
      renderer = create(<Harness onContinue={() => {}} localAvailable />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Waiting for this node to connect…");
    expect(
      renderer!.root
        .findAllByType("input")
        .filter((input) => input.props.id === "onboarding-device-name"),
    ).toHaveLength(0);
    await act(async () => renderer?.unmount());

    // Node connected: the rename field renders with an accessible label.
    testState.primaryEnvironmentId = localId;
    testState.primaryEnvironment = {
      environmentId: localId,
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
    };
    testState.environments = [
      {
        environmentId: localId,
        label: "laptop",
        connection: { phase: "connected" },
        displayUrl: null,
      },
    ];
    await act(async () => {
      renderer = create(<Harness onContinue={() => {}} localAvailable />);
    });
    const nameInput = renderer!.root
      .findAllByType("input")
      .find((input) => input.props.id === "onboarding-device-name");
    expect(nameInput?.props["aria-label"]).toBe("Name this computer");
  });
});

describe("onboarding pairing selection", () => {
  it("adds each paired computer to the current selection", async () => {
    const oneId = EnvironmentId.make("computer-one");
    const twoId = EnvironmentId.make("computer-two");
    const gates = [deferredPairing(), deferredPairing()];
    let calls = 0;
    testState.connectPairing.mockImplementation(async () => {
      calls += 1;
      const gate = gates[calls - 1]!;
      const id = calls === 1 ? oneId : twoId;
      const result = await gate.promise;
      testState.environments = [
        ...testState.environments,
        {
          environmentId: id,
          label: calls === 1 ? "Computer One" : "Computer Two",
          connection: { phase: "connected" },
          displayUrl: null,
        },
      ];
      return result;
    });

    await act(async () => {
      renderer = create(<WizardHarness />);
    });
    const submitPairing = async () => {
      await act(async () => {
        pairingUrlInput().props.onChange({
          currentTarget: { value: `https://nas.example/pair#token=${calls}` },
        });
      });
      await act(async () => {
        renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
      });
    };

    await submitPairing();
    gates[0]!.resolve({ _tag: "Success", value: oneId });
    await act(async () => {});
    expect(checkboxWithLabel("Set up Computer One").props.checked).toBe(true);

    // The first computer is deselected before the second pairing completes;
    // the completion must add to the current selection, never resurrect the
    // removed row. (The updater is functional so a completion racing a toggle
    // cannot clobber it even when both land in one batch.)
    await act(async () => {
      checkboxWithLabel("Set up Computer One").props.onChange({ target: { checked: false } });
    });
    await submitPairing();
    gates[1]!.resolve({ _tag: "Success", value: twoId });
    await act(async () => {});
    await act(async () => {});

    expect(checkboxWithLabel("Set up Computer One").props.checked).toBe(false);
    expect(checkboxWithLabel("Set up Computer Two").props.checked).toBe(true);
  });
});

describe("onboarding mesh switch", () => {
  it("applies the toggle optimistically with an Applying status", async () => {
    testState.cloudPublicConfig = true;
    testState.clerkAuth = { isLoaded: true, isSignedIn: true };
    const localId = EnvironmentId.make("this-computer");
    testState.cloudLink.target = { environmentId: localId };
    let resolveReconcile!: (value: boolean) => void;
    const reconciled = new Promise<boolean>((innerResolve) => {
      resolveReconcile = innerResolve;
    });
    testState.cloudLink.reconcile.mockImplementation(() => reconciled);
    vi.stubGlobal("window", { desktopBridge: {} });

    await act(async () => {
      renderer = create(<WizardHarness />);
    });
    const meshSwitch = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Available to my other devices");
    if (meshSwitch === undefined) throw new Error("No mesh switch");

    await act(async () => {
      meshSwitch.props.onClick();
    });
    // Intent reflects immediately while the relay round-trip is in flight.
    expect(meshSwitch.props["aria-pressed"]).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Applying…");
    expect(meshSwitch.props.disabled).toBe(true);

    resolveReconcile(true);
    await act(async () => {});
    await act(async () => {});
    // The mock link never flips, so the switch falls back to server truth.
    expect(meshSwitch.props["aria-pressed"]).toBe(false);
    expect(meshSwitch.props.disabled).toBe(false);
    expect(testState.cloudLink.reconcile).toHaveBeenCalledWith({
      managedTunnel: true,
      publish: true,
    });
  });
});

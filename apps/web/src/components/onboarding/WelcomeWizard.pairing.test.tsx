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
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));

vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));

vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linked: false,
    managedTunnelActive: false,
    publishAgentActivity: false,
    reconcileCloudState: vi.fn(),
    linkState: { target: null },
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
  }) => (
    <input
      type="checkbox"
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
  }) => <input id={props.id} value={props.value ?? ""} onChange={props.onChange} />,
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/switch", () => ({ Switch: () => null }));
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

import { ConnectionStep } from "./WelcomeWizard";

let renderer: ReactTestRenderer | null = null;

function Harness({ onContinue }: { readonly onContinue: () => void }) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(new Set());
  return (
    <ConnectionStep
      localAvailable={false}
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

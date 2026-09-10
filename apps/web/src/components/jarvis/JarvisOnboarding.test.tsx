import type { ReactElement } from "react";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ServerEnvironmentLabelError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

type Props = Record<string, unknown>;

const atoms = vi.hoisted(() => ({
  configAtom: Symbol("primary-server-config"),
  setLabel: Symbol("set-environment-label"),
  refresh: Symbol("refresh-mesh"),
}));

const environmentId = EnvironmentId.make("primary-node");

const state = vi.hoisted(() => ({
  primaryId: null as EnvironmentId | null,
  primary: null as {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly displayUrl: string | null;
    readonly relayManaged: boolean;
    readonly entry: { readonly target: { readonly _tag: string; readonly label: string } };
    readonly connection: { readonly phase: string };
  } | null,
  serverConfig: null as {
    readonly environment: {
      readonly label: string;
      readonly capabilities: { readonly jarvisNode: null };
    };
  } | null,
}));

const commands = vi.hoisted(() => ({
  saveLabel: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: symbol) => {
    if (atom === atoms.configAtom) return state.serverConfig;
    return null;
  },
}));

vi.mock("../../state/server", () => ({
  primaryServerConfigAtom: atoms.configAtom,
  serverEnvironment: { setEnvironmentLabel: atoms.setLabel },
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => state.primary,
  usePrimaryEnvironmentId: () => state.primaryId,
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: [],
    presentationById: new Map(),
  }),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null }),
}));

vi.mock("../../state/jarvisMesh", () => ({
  jarvisMeshEnvironment: { refresh: atoms.refresh },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === atoms.setLabel ? commands.saveLabel : commands.refresh,
}));

import { JarvisOnboarding } from "./JarvisOnboarding";

function renderDialog(): ReactElement<Props> {
  hooks.beginRender();
  return JarvisOnboarding({
    open: true,
    onOpenChange: () => undefined,
    onOpenConnections: () => undefined,
    onOpenProviderSettings: () => undefined,
  }) as unknown as ReactElement<Props>;
}

function collectText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    const props = (node as { readonly props?: unknown }).props;
    if (props !== null && typeof props === "object" && "children" in props) {
      return collectText((props as { readonly children?: unknown }).children);
    }
  }
  return "";
}

function mustFind(
  dialog: ReactElement<Props>,
  visitor: (element: ReactElement<Props>) => boolean,
  what: string,
): ReactElement<Props> {
  const found = visitElements(dialog, visitor);
  if (found === null) throw new Error(`Missing expected onboarding element: ${what}`);
  return found;
}

function findInput(dialog: ReactElement<Props>) {
  return visitElements(
    dialog,
    (element) => (element.props.placeholder as unknown) === "This device",
  );
}

function mustInput(dialog: ReactElement<Props>): ReactElement<Props> {
  return mustFind(
    dialog,
    (element) => (element.props.placeholder as unknown) === "This device",
    "device name input",
  );
}

function typeDeviceName(dialog: ReactElement<Props>, value: string): void {
  const input = mustInput(dialog);
  const onChange = input.props.onChange as (event: { target: { value: string } }) => void;
  if (typeof onChange !== "function") throw new Error("Missing device name onChange");
  onChange({ target: { value } });
}

function inputValue(dialog: ReactElement<Props>): string | null {
  const input = findInput(dialog);
  if (input === null) return null;
  return input.props.value as string;
}

function errorText(dialog: ReactElement<Props>): string | null {
  const error = visitElements(
    dialog,
    (element) => (element.props.id as unknown) === "jarvis-device-name-error",
  );
  if (error === null) return null;
  return collectText(error.props.children);
}

function clickContinue(dialog: ReactElement<Props>): void {
  const button = mustFind(
    dialog,
    (element) => {
      if (typeof element.props.onClick !== "function") return false;
      const text = collectText(element.props.children);
      return text.includes("Continue") || text.includes("Saving");
    },
    "Continue button",
  );
  const onClick = button.props.onClick as () => void;
  if (typeof onClick !== "function") throw new Error("Missing Continue onClick");
  onClick();
}

function continueDisabled(dialog: ReactElement<Props>): unknown {
  const button = mustFind(
    dialog,
    (element) => {
      if (typeof element.props.onClick !== "function") return false;
      const text = collectText(element.props.children);
      return text.includes("Continue") || text.includes("Saving");
    },
    "Continue button",
  );
  return button.props.disabled;
}

function findEssentials(dialog: ReactElement<Props>) {
  return visitElements(
    dialog,
    (element) => (element.props["aria-labelledby"] as unknown) === "jarvis-onboarding-essentials",
  );
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("JarvisOnboarding device save", () => {
  beforeEach(() => {
    hooks.reset();
    state.primaryId = environmentId;
    state.primary = {
      environmentId,
      label: "fedora",
      displayUrl: "http://127.0.0.1:14363",
      relayManaged: false,
      entry: { target: { _tag: "PrimaryConnectionTarget", label: "fedora" } },
      connection: { phase: "connected" },
    };
    state.serverConfig = { environment: { label: "fedora", capabilities: { jarvisNode: null } } };
    commands.saveLabel.mockReset();
    commands.refresh.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { nodes: [], projects: [], providers: [] },
    });
  });

  it("shows the server reason when the label mutation fails and keeps the typed name", async () => {
    commands.saveLabel.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(
        new ServerEnvironmentLabelError({ message: "Failed to write environment-label file." }),
      ),
    });

    typeDeviceName(renderDialog(), "New name");

    const typed = renderDialog();
    expect(inputValue(typed)).toBe("New name");

    clickContinue(typed);
    await flushPromises();

    const failed = renderDialog();
    expect(errorText(failed)).toBe(
      "The server couldn't save the name (Failed to write environment-label file.). Try again.",
    );
    // Still on the device step with the draft preserved for retry.
    expect(inputValue(failed)).toBe("New name");
    expect(commands.saveLabel).toHaveBeenCalledTimes(1);
    expect(commands.saveLabel).toHaveBeenCalledWith({
      environmentId,
      input: { label: "New name" },
    });
  });

  it("names the missing scope when the session may not rename the device", async () => {
    commands.saveLabel.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(
        new EnvironmentAuthorizationError({
          message: "The authenticated token is missing required scope: orchestration:operate.",
          requiredScope: "orchestration:operate",
        }),
      ),
    });

    typeDeviceName(renderDialog(), "New name");
    clickContinue(renderDialog());
    await flushPromises();

    const failed = renderDialog();
    expect(errorText(failed)).toBe(
      "You don't have permission to rename this device (needs orchestration:operate). " +
        "Ask an admin to rename it, then try again.",
    );
    expect(inputValue(failed)).toBe("New name");
  });

  it("keeps the original message for failures it cannot classify", async () => {
    commands.saveLabel.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("transport failed")),
    });

    typeDeviceName(renderDialog(), "New name");
    clickContinue(renderDialog());
    await flushPromises();

    expect(errorText(renderDialog())).toBe("Could not save the device name.");
  });

  it("explains a stale connection instead of reporting a generic failure", async () => {
    commands.saveLabel.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail({ _tag: "EnvironmentNotRegisteredError" }),
    });

    typeDeviceName(renderDialog(), "New name");
    clickContinue(renderDialog());
    await flushPromises();

    expect(errorText(renderDialog())).toBe(
      "This device isn't connected. Reconnect it and try again.",
    );
  });

  it("advances past the device step when the server accepts the trimmed name", async () => {
    commands.saveLabel.mockResolvedValue({ _tag: "Success", value: { label: "New name" } });

    typeDeviceName(renderDialog(), "  New name  ");
    clickContinue(renderDialog());
    await flushPromises();

    const advanced = renderDialog();
    expect(errorText(advanced)).toBeNull();
    expect(findInput(advanced)).toBeNull();
    expect(findEssentials(advanced)).not.toBeNull();
    expect(commands.saveLabel).toHaveBeenCalledWith({
      environmentId,
      input: { label: "New name" },
    });
  });

  it("rejects an empty name locally without calling the server", async () => {
    typeDeviceName(renderDialog(), "   ");
    clickContinue(renderDialog());
    await flushPromises();

    expect(errorText(renderDialog())).toBe("Enter a device name.");
    expect(commands.saveLabel).not.toHaveBeenCalled();
  });

  it("disables Continue when no primary node is ready", () => {
    state.primaryId = null;
    state.primary = null;
    state.serverConfig = null;

    expect(continueDisabled(renderDialog())).toBe(true);
    expect(commands.saveLabel).not.toHaveBeenCalled();
  });
});

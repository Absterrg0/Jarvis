import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { JarvisVoiceReporter } from "./components/jarvis/JarvisVoiceReporter";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

vi.mock("./env", () => ({
  isJarvisCompanion: false,
  isJarvisCompanionRelay: true,
}));

import { AppRoot } from "./AppRoot";

describe("AppRoot report relay", () => {
  it("mounts only the voice reporter in the hidden paired relay", () => {
    const root = AppRoot({ router: {} as AppRouter });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(children).toHaveLength(1);
    expect(isValidElement(children[0]) && children[0].type).toBe(JarvisVoiceReporter);
  });
});

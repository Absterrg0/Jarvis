import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { JarvisManagerHost } from "./components/jarvis/JarvisManagerHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

export function notifyRendererReady() {
  if (typeof window === "undefined") return;
  window.desktopBridge?.notifyRendererReady?.();
}

function RendererReadySignal() {
  useEffect(() => {
    notifyRendererReady();
  }, []);

  return null;
}

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RendererReadySignal />
      <RouterProvider router={router} />
      <JarvisManagerHost router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}

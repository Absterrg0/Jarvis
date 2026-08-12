import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { JarvisManagerHost } from "./components/jarvis/JarvisManagerHost";
import { isJarvisCompanion } from "./env";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  if (isJarvisCompanion) {
    return (
      <AppAtomRegistryProvider>
        <div className="fixed inset-0 overflow-hidden bg-[#09090b]">
          <div aria-hidden className="invisible pointer-events-none">
            <RouterProvider router={router} />
          </div>
          <JarvisManagerHost companionMode router={router} />
        </div>
      </AppAtomRegistryProvider>
    );
  }

  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <JarvisManagerHost router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
    </AppAtomRegistryProvider>
  );
}

import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const JarvisControlCenter = lazy(async () => {
  const module = await import("../components/jarvis/JarvisControlCenter");
  return { default: module.JarvisControlCenter };
});

function JarvisControlCenterRoute() {
  return (
    <Suspense fallback={null}>
      <JarvisControlCenter />
    </Suspense>
  );
}

export const Route = createFileRoute("/jarvis")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: JarvisControlCenterRoute,
});

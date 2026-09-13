import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const CirceControlCenter = lazy(async () => {
  const module = await import("../components/circe/CirceControlCenter");
  return { default: module.CirceControlCenter };
});

function CirceControlCenterRoute() {
  return (
    <Suspense fallback={null}>
      <CirceControlCenter />
    </Suspense>
  );
}

export const Route = createFileRoute("/circe")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: CirceControlCenterRoute,
});

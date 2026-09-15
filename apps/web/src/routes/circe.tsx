import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const CirceOverview = lazy(async () => {
  const module = await import("../components/circe/CirceOverview");
  return { default: module.CirceOverview };
});

function CirceOverviewRoute() {
  return (
    <Suspense fallback={null}>
      <CirceOverview />
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
  component: CirceOverviewRoute,
});

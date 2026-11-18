import { createFileRoute } from "@tanstack/react-router";

import { GrantOfferSurface } from "../components/grants/GrantOfferSurface";

// Grants ticket 06: a lending link, `/grants/offer#token=<token>`.
export const Route = createFileRoute("/grants/offer")({
  component: GrantOfferRouteView,
});

function GrantOfferRouteView() {
  const { authGateState } = Route.useRouteContext();
  return <GrantOfferSurface signedIn={authGateState.status === "authenticated"} />;
}

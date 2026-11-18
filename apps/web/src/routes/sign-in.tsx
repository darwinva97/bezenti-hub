import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import { SignInSurface } from "../components/auth/SignInSurface";
import { GRANT_OFFER_PATH, hasPendingGrantOffer } from "../components/grants/grantOfferLink";

export const Route = createFileRoute("/sign-in")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status !== "requires-auth") {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: SignInRouteView,
});

function SignInRouteView() {
  const router = useRouter();
  return (
    <SignInSurface
      onSignedIn={() => {
        // Recreate the connection so WebSocket and cached scopes use the new session cookie.
        // A lending link opened before signing in comes back (its token waits in the tab).
        router.history.replace(hasPendingGrantOffer() ? GRANT_OFFER_PATH : "/");
        router.history.flush();
        window.location.reload();
      }}
    />
  );
}

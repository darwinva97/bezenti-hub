import type { AuthResetLinkStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { peekPairingTokenFromUrl, stripPairingTokenFromUrl } from "../../environments/primary/auth";
import {
  fetchResetLinkStatus,
  resetPasskey,
  resetPassword,
  startKeycloak,
} from "../../environments/primary/userAccounts";
import { keycloakResultMessage } from "./keycloakSignIn.logic";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { canRegisterPasskeys } from "./OwnerSetupSurface";

type LinkState = { readonly status: "checking" } | AuthResetLinkStatus;

export function ResetPasskeySurface({ onFinished }: { onFinished: () => void }) {
  // The fragment never reaches the server; read it once, then drop it from the address bar.
  const [token] = useState(peekPairingTokenFromUrl);
  const [link, setLink] = useState<LinkState>(
    token === null ? { status: "invalid" } : { status: "checking" },
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [method, setMethod] = useState<"passkey" | "password">("passkey");
  const [loginName, setLoginName] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  // Keycloak 08: a reset through Keycloak that did not go through comes back with `?keycloak=`.
  const [keycloakRefusal] = useState(() => keycloakResultMessage(window.location.search));

  const resetWithKeycloak = () => {
    if (token === null) return;
    // The browser leaves for the realm; only a refusal to start comes back here.
    setIsSubmitting(true);
    setErrorMessage("");
    startKeycloak({ intent: "reset", returnTo: "/", resetToken: token }).catch((cause: unknown) => {
      setErrorMessage(cause instanceof Error ? cause.message : "The reset failed.");
      setIsSubmitting(false);
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the reset token from the URL and asks the server whether the link is still live
  useEffect(() => {
    if (token === null) return;
    stripPairingTokenFromUrl();
    let cancelled = false;
    void fetchResetLinkStatus(token).then(
      (status) => {
        if (!cancelled) setLink(status);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setLink({ status: "invalid" });
        setErrorMessage(cause instanceof Error ? cause.message : "Could not check this link.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleReset = async () => {
    if (token === null || link.status !== "valid") return;
    setIsSubmitting(true);
    setErrorMessage("");
    const reset =
      method === "passkey"
        ? resetPasskey(token)
        : resetPassword({ token, loginName: (loginName ?? link.loginName ?? "").trim(), password });
    const error = await reset.then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : "The reset failed."),
    );
    setIsSubmitting(false);
    if (error) {
      setErrorMessage(error);
      return;
    }
    onFinished();
  };

  if (link.status === "checking") {
    return (
      <StandalonePage>
        <StandalonePageHeader title="Checking reset link" description="One moment..." />
      </StandalonePage>
    );
  }

  if (link.status === "invalid" && token === null && keycloakRefusal !== null) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title="The reset did not go through"
          description="Open your reset link again to try once more. It still works unless it expired or was used."
        />
        <div className="mt-6">
          <Alert variant="error">
            <AlertDescription>{keycloakRefusal}</AlertDescription>
          </Alert>
        </div>
      </StandalonePage>
    );
  }

  if (link.status === "invalid") {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title="This reset link no longer works"
          description="Reset links work once and expire after an hour. Ask the Owner for a new one. The Owner runs `t3 auth owner-reset` in the Hub's shell."
        />
        {errorMessage ? (
          <div className="mt-6">
            <Alert variant="error">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          </div>
        ) : null}
      </StandalonePage>
    );
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={`Reset the sign-in for ${link.displayName}`}
        description="Your old passkeys, password and authenticator app stop working, and every device signed in to this account is signed out. This link works once."
      />
      <div className="mt-6 space-y-4">
        {link.keycloak === true ? (
          <Button
            disabled={isSubmitting}
            size="sm"
            variant={link.local === false ? "default" : "outline"}
            onClick={resetWithKeycloak}
          >
            Continue with Keycloak
          </Button>
        ) : null}
        {link.local === false ? (
          <p className="text-sm text-muted-foreground">
            This Hub signs everyone but its Owner in with Keycloak. Your Keycloak account becomes
            this account&apos;s way in.
          </p>
        ) : method === "password" ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handleReset();
            }}
          >
            <label className="block text-sm font-medium" htmlFor="reset-sign-in-name">
              Sign-in name
            </label>
            <Input
              id="reset-sign-in-name"
              autoCapitalize="none"
              autoComplete="username"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setLoginName(event.currentTarget.value)}
              spellCheck={false}
              value={loginName ?? link.loginName ?? ""}
            />
            <label className="block text-sm font-medium" htmlFor="reset-password">
              New password
            </label>
            <Input
              id="reset-password"
              autoComplete="new-password"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setPassword(event.currentTarget.value)}
              type="password"
              value={password}
            />
            <Button
              disabled={
                isSubmitting || password.length < 8 || !(loginName ?? link.loginName ?? "").trim()
              }
              size="sm"
              type="submit"
            >
              Set new password
            </Button>
          </form>
        ) : canRegisterPasskeys() ? (
          <Button disabled={isSubmitting} size="sm" onClick={() => void handleReset()}>
            {isSubmitting ? "Waiting for your passkey..." : "Register a new passkey"}
          </Button>
        ) : (
          <Alert variant="error">
            <AlertDescription>
              Passkeys need the Installation's own HTTPS address (or localhost). Open this link
              there.
            </AlertDescription>
          </Alert>
        )}
        {link.passwordAllowed === true ? (
          <Button
            disabled={isSubmitting}
            size="sm"
            variant="ghost"
            onClick={() => {
              setMethod(method === "passkey" ? "password" : "passkey");
              setErrorMessage("");
            }}
          >
            {method === "passkey" ? "Set a new password instead" : "Use a passkey instead"}
          </Button>
        ) : null}
        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </StandalonePage>
  );
}

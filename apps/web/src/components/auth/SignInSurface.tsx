import { type ReactNode, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  signInWithPasskey,
  signInWithPassword,
  signInWithRecoveryCode,
  signInWithTotp,
  startKeycloak,
} from "../../environments/primary/userAccounts";
import {
  keycloakResultCode,
  keycloakResultMessage,
  keycloakReturnTo,
} from "./keycloakSignIn.logic";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

type Method = "passkey" | "password" | "recovery";

export function SignInSurface({
  onSignedIn,
  description = "Use your passkey, or your sign-in name and password.",
  footer,
}: {
  onSignedIn: () => void;
  description?: ReactNode;
  /** Shown under the sign-in methods, such as another way to continue. */
  footer?: ReactNode;
}) {
  const [method, setMethod] = useState<Method>("passkey");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [totpChallengeId, setTotpChallengeId] = useState<string | null>(null);
  const needsTotp = totpChallengeId !== null;
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  // A refused Keycloak sign-in comes back here with `?keycloak=<why>`.
  const [errorMessage, setErrorMessage] = useState(
    () => keycloakResultMessage(window.location.search) ?? "",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const keycloakOffered = usePrimarySessionState().data?.signInOptions?.keycloak === true;
  // Refused for a sign-in without the second factor the Role needs: offer to ask for it.
  const [retryStrong] = useState(
    () => keycloakResultCode(window.location.search) === "strong-factor-required",
  );
  const startKeycloakSignIn = (strongFactor: boolean) => {
    // The browser leaves for the realm; only a refusal to start comes back here.
    setIsSubmitting(true);
    setErrorMessage("");
    startKeycloak({
      intent: "sign-in",
      returnTo: keycloakReturnTo(window.location),
      strongFactor,
    }).catch((cause: unknown) => {
      setErrorMessage(cause instanceof Error ? cause.message : "Sign-in failed.");
      setIsSubmitting(false);
    });
  };

  const attempt = async (
    signIn: () => Promise<{ readonly totpChallengeId: string } | "signed-in" | void>,
  ) => {
    setIsSubmitting(true);
    setErrorMessage("");
    const outcome = await signIn().then(
      (result) => ({ ok: true as const, result }),
      (cause: unknown) => ({
        ok: false as const,
        message: cause instanceof Error ? cause.message : "Sign-in failed.",
      }),
    );
    setIsSubmitting(false);
    if (!outcome.ok) {
      setErrorMessage(outcome.message);
      // A code step that failed may be spent; the password step starts a new one.
      setTotpChallengeId(null);
      setTotpCode("");
      return;
    }
    if (typeof outcome.result === "object") {
      setTotpChallengeId(outcome.result.totpChallengeId);
      return;
    }
    onSignedIn();
  };

  const choose = (next: Method) => {
    setMethod(next);
    setTotpChallengeId(null);
    setTotpCode("");
    setErrorMessage("");
  };

  return (
    <StandalonePage>
      <StandalonePageHeader title="Sign in" description={description} />

      <div className="mt-6 space-y-4">
        {keycloakOffered && retryStrong ? (
          <Button disabled={isSubmitting} size="sm" onClick={() => startKeycloakSignIn(true)}>
            Retry with second factor
          </Button>
        ) : null}
        {keycloakOffered ? (
          <Button
            disabled={isSubmitting}
            size="sm"
            variant="outline"
            onClick={() => startKeycloakSignIn(false)}
          >
            Sign in with Keycloak
          </Button>
        ) : null}
        {method === "passkey" ? (
          <Button disabled={isSubmitting} size="sm" onClick={() => void attempt(signInWithPasskey)}>
            {isSubmitting ? "Waiting for your passkey..." : "Sign in with a passkey"}
          </Button>
        ) : null}

        {method === "password" ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void attempt(() =>
                totpChallengeId === null
                  ? signInWithPassword({ loginName, password })
                  : signInWithTotp({
                      challengeId: totpChallengeId,
                      code: totpCode.replace(/\s/g, ""),
                    }),
              );
            }}
          >
            <label className="block text-sm font-medium" htmlFor="sign-in-name">
              Sign-in name
            </label>
            <Input
              id="sign-in-name"
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect="off"
              disabled={isSubmitting || needsTotp}
              nativeInput
              onChange={(event) => setLoginName(event.currentTarget.value)}
              spellCheck={false}
              value={loginName}
            />
            <label className="block text-sm font-medium" htmlFor="sign-in-password">
              Password
            </label>
            <Input
              id="sign-in-password"
              autoComplete="current-password"
              disabled={isSubmitting || needsTotp}
              nativeInput
              onChange={(event) => setPassword(event.currentTarget.value)}
              type="password"
              value={password}
            />
            {needsTotp ? (
              <>
                <label className="block text-sm font-medium" htmlFor="sign-in-totp">
                  Code from your authenticator app
                </label>
                <Input
                  id="sign-in-totp"
                  autoComplete="one-time-code"
                  autoFocus
                  disabled={isSubmitting}
                  inputMode="numeric"
                  nativeInput
                  onChange={(event) => setTotpCode(event.currentTarget.value)}
                  placeholder="123456"
                  value={totpCode}
                />
              </>
            ) : null}
            <Button
              disabled={
                isSubmitting ||
                !loginName.trim() ||
                !password ||
                (needsTotp && totpCode.replace(/\s/g, "").length !== 6)
              }
              size="sm"
              type="submit"
            >
              {needsTotp ? "Verify code" : "Sign in"}
            </Button>
          </form>
        ) : null}

        {method === "recovery" ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void attempt(() => signInWithRecoveryCode(recoveryCode));
            }}
          >
            <label className="text-sm font-medium" htmlFor="recovery-code">
              Recovery code
            </label>
            <Input
              id="recovery-code"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setRecoveryCode(event.currentTarget.value)}
              placeholder="XXXXX-XXXXX"
              spellCheck={false}
              value={recoveryCode}
            />
            <Button disabled={isSubmitting || !recoveryCode.trim()} size="sm" type="submit">
              Use recovery code
            </Button>
          </form>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {method !== "passkey" ? (
            <Button
              disabled={isSubmitting}
              size="sm"
              variant="ghost"
              onClick={() => choose("passkey")}
            >
              Use a passkey instead
            </Button>
          ) : null}
          {method !== "password" ? (
            <Button
              disabled={isSubmitting}
              size="sm"
              variant="ghost"
              onClick={() => choose("password")}
            >
              Sign in with a password
            </Button>
          ) : null}
          {method !== "recovery" ? (
            <Button
              disabled={isSubmitting}
              size="sm"
              variant="ghost"
              onClick={() => choose("recovery")}
            >
              Lost your passkey? Use a recovery code
            </Button>
          ) : null}
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        {footer}
      </div>
    </StandalonePage>
  );
}

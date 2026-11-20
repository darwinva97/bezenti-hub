import { SPACE_ROLE_LABELS } from "@t3tools/client-runtime/spaces/invitations";
import {
  AuthLoginName,
  type AuthTotpEnrollment,
  type InvitationPreview,
  type SpaceRole,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { peekPairingTokenFromUrl, stripPairingTokenFromUrl } from "../../environments/primary/auth";
import {
  acceptInvitationWithPasskey,
  acceptInvitationWithPassword,
  fetchAccount,
  fetchInvitationPreview,
  joinInvitation,
  signOut,
  startInvitationTotpEnrollment,
  startKeycloak,
} from "../../environments/primary/userAccounts";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { keycloakResultMessage } from "./keycloakSignIn.logic";
import { canRegisterPasskeys } from "./OwnerSetupSurface";

const isLoginName = Schema.is(AuthLoginName);

type LinkState = { readonly status: "checking" } | InvitationPreview;
type Method = "passkey" | "password";

// The tab keeps the token until the Invitation is accepted or found invalid, so a reload or
// switching account mid-way does not lose it; it never goes back into the address bar.
const TOKEN_STORAGE_KEY = "t3code:invitation-token";

function takeInvitationToken(): string | null {
  const fromUrl = peekPairingTokenFromUrl();
  try {
    if (fromUrl !== null) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl ?? window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return fromUrl;
  }
}

export function forgetInvitationToken() {
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing was kept.
  }
}

/**
 * Where an Invitation link lands: who invites you to which Organization with what Role, the
 * notice that the Owner sees every Personal space, then creating the User (or, signed in, adding
 * the Organization to yours).
 */
export function InvitationSurface({
  signedIn,
  onAccepted,
}: {
  readonly signedIn: boolean;
  readonly onAccepted: (result: { readonly userId: string; readonly spaceId: string }) => void;
}) {
  // The fragment never reaches the server; read it once, then drop it from the address bar.
  const [token] = useState(takeInvitationToken);
  const [link, setLink] = useState<LinkState>(
    token === null ? { status: "invalid" } : { status: "checking" },
  );
  const [errorMessage, setErrorMessage] = useState("");
  // Accepting through Keycloak that did not go through comes back here with `?keycloak=<why>`.
  const [keycloakResult] = useState(() => keycloakResultMessage(window.location.search));
  const keycloakOffered = usePrimarySessionState().data?.signInOptions?.keycloak === true;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the invitation token from the URL and asks the server whether it is still valid
  useEffect(() => {
    if (token === null) return;
    stripPairingTokenFromUrl();
    let cancelled = false;
    void fetchInvitationPreview(token).then(
      (preview) => {
        if (preview.status === "invalid") forgetInvitationToken();
        if (!cancelled) setLink(preview);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setLink({ status: "invalid" });
        setErrorMessage(messageOf(cause, "Could not check this invitation."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (link.status === "checking") {
    return (
      <StandalonePage>
        <StandalonePageHeader title="Checking invitation" description="One moment..." />
      </StandalonePage>
    );
  }

  if (link.status === "invalid" || token === null) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title="This invitation is no longer valid"
          description="Invitations work once and expire after 7 days. Ask whoever invited you for a new link."
        />
        {errorMessage || keycloakResult ? (
          <div className="mt-6">
            <Alert variant="error">
              <AlertDescription>{errorMessage || keycloakResult}</AlertDescription>
            </Alert>
          </div>
        ) : null}
      </StandalonePage>
    );
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={`Join ${link.organizationName}`}
        description={`${link.inviterName} invited you as ${SPACE_ROLE_LABELS[link.role]}.`}
      />
      <div className="mt-6 space-y-4">
        {keycloakResult ? (
          <Alert variant="error">
            <AlertDescription>{keycloakResult}</AlertDescription>
          </Alert>
        ) : null}
        <Alert>
          <AlertDescription>
            You also have a Personal space, which opens once the Owner allows it. The Owner of this
            Installation can see what you keep there; nothing in it is shared with anyone else.
          </AlertDescription>
        </Alert>
        {signedIn ? (
          <JoinAsSignedInUser token={token} onAccepted={onAccepted} />
        ) : (
          <>
            {keycloakOffered ? <AcceptWithKeycloak token={token} /> : null}
            <CreateInvitedUser token={token} role={link.role} onAccepted={onAccepted} />
          </>
        )}
      </div>
    </StandalonePage>
  );
}

/**
 * Accepting by signing in (or signing up) at Keycloak: the token goes to the Hub, which checks it
 * and keeps it; the browser comes back signed in, or to this page with the reason.
 */
function AcceptWithKeycloak({ token }: { readonly token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accept = () => {
    setBusy(true);
    setError("");
    startKeycloak({ intent: "invitation", invitationToken: token, returnTo: "/" }).catch(
      (cause: unknown) => {
        setError(messageOf(cause, "Could not start signing in with Keycloak."));
        setBusy(false);
      },
    );
  };
  return (
    <div className="space-y-2">
      <Button disabled={busy} size="sm" variant="outline" onClick={accept}>
        Sign in with Keycloak to accept
      </Button>
      <p className="text-xs text-muted-foreground">
        Already have an account on this Hub? Sign in with it first, then open this link again. Or
        create an account below.
      </p>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function JoinAsSignedInUser({
  token,
  onAccepted,
}: {
  readonly token: string;
  readonly onAccepted: (result: { readonly userId: string; readonly spaceId: string }) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server who is signed in, so the page names the account the link would join
  useEffect(() => {
    let cancelled = false;
    void fetchAccount().then(
      (account) => {
        if (!cancelled) setName(account.user.displayName);
      },
      () => {
        if (!cancelled) setName("");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const switchAccount = async () => {
    setBusy(true);
    await signOut().catch(() => undefined);
    // The token stays in this tab, so the page comes back with the form for a new account.
    window.location.replace("/invite");
  };
  const join = async () => {
    setBusy(true);
    setError("");
    try {
      onAccepted(await joinInvitation(token));
    } catch (cause) {
      setError(messageOf(cause, "Could not join. Try again."));
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {name ? `Signed in as ${name}.` : "You're signed in."} Accepting adds the Organization to
        this account.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || name === null} size="sm" onClick={() => void join()}>
          {name ? `Accept as ${name}` : "Accept invitation"}
        </Button>
        <Button disabled={busy} size="sm" variant="ghost" onClick={() => void switchAccount()}>
          Use a different account
        </Button>
      </div>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function CreateInvitedUser({
  token,
  role,
  onAccepted,
}: {
  readonly token: string;
  readonly role: SpaceRole;
  readonly onAccepted: (result: { readonly userId: string; readonly spaceId: string }) => void;
}) {
  const passkeysWork = canRegisterPasskeys();
  const [method, setMethod] = useState<Method>(passkeysWork ? "passkey" : "password");
  const [displayName, setDisplayName] = useState("");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [enrollment, setEnrollment] = useState<AuthTotpEnrollment | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Admins need more than a password: a passkey, or a password with an authenticator app.
  const needsTotp = role === "admin" && method === "password";

  const run = async (
    action: () => Promise<{ readonly userId: string; readonly spaceId: string }>,
  ) => {
    setBusy(true);
    setError("");
    try {
      onAccepted(await action());
    } catch (cause) {
      setError(messageOf(cause, "Could not create your account. Try again."));
      setBusy(false);
    }
  };

  const startTotp = async () => {
    setBusy(true);
    setError("");
    try {
      setEnrollment(await startInvitationTotpEnrollment(token));
    } catch (cause) {
      setError(messageOf(cause, "Could not start the authenticator setup."));
    }
    setBusy(false);
  };

  const name = displayName.trim();
  const code = totpCode.replace(/\s/g, "");
  const passwordReady =
    name.length > 0 &&
    isLoginName(loginName.trim()) &&
    password.length >= 8 &&
    (!needsTotp || (enrollment !== null && code.length === 6));

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (method === "passkey") {
          void run(() => acceptInvitationWithPasskey({ token, displayName: name }));
        } else {
          void run(() =>
            acceptInvitationWithPassword({
              token,
              displayName: name,
              loginName: loginName.trim(),
              password,
              ...(needsTotp && enrollment !== null
                ? { totp: { enrollmentId: enrollment.enrollmentId, code } }
                : {}),
            }),
          );
        }
      }}
    >
      <label className="block text-sm font-medium" htmlFor="invite-display-name">
        Your name
      </label>
      <Input
        id="invite-display-name"
        autoComplete="name"
        disabled={busy}
        maxLength={80}
        nativeInput
        onChange={(event) => setDisplayName(event.currentTarget.value)}
        value={displayName}
      />

      {method === "password" ? (
        <>
          <label className="block text-sm font-medium" htmlFor="invite-login-name">
            Sign-in name
          </label>
          <Input
            id="invite-login-name"
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect="off"
            disabled={busy}
            nativeInput
            onChange={(event) => setLoginName(event.currentTarget.value)}
            spellCheck={false}
            value={loginName}
          />
          <label className="block text-sm font-medium" htmlFor="invite-password">
            Password (at least 8 characters)
          </label>
          <Input
            id="invite-password"
            autoComplete="new-password"
            disabled={busy}
            nativeInput
            onChange={(event) => setPassword(event.currentTarget.value)}
            type="password"
            value={password}
          />
          {needsTotp ? (
            enrollment === null ? (
              <div className="space-y-2 pt-2">
                <p className="text-sm text-muted-foreground">
                  As an Admin you also need an authenticator app with your password.
                </p>
                <Button
                  disabled={busy}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void startTotp()}
                >
                  Set up an authenticator app
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 pt-2">
                <p className="text-sm text-muted-foreground">
                  Scan this with your authenticator app, then enter the code it shows.
                </p>
                <div className="self-start rounded-lg bg-white p-1.5">
                  <QRCodeSvg
                    value={enrollment.otpauthUri}
                    size={160}
                    level="M"
                    marginSize={1}
                    title="Authenticator app setup code"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Can't scan? Enter this key:{" "}
                  <code className="select-all">{enrollment.secret}</code>
                </p>
                <label className="block text-sm font-medium" htmlFor="invite-totp">
                  Code from your authenticator app
                </label>
                <Input
                  id="invite-totp"
                  autoComplete="one-time-code"
                  disabled={busy}
                  inputMode="numeric"
                  nativeInput
                  onChange={(event) => setTotpCode(event.currentTarget.value)}
                  placeholder="123456"
                  value={totpCode}
                />
              </div>
            )
          ) : null}
        </>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-2">
        <Button
          disabled={busy || (method === "passkey" ? name.length === 0 : !passwordReady)}
          size="sm"
          type="submit"
        >
          {method === "passkey"
            ? busy
              ? "Waiting for your passkey..."
              : "Create account with a passkey"
            : "Create account"}
        </Button>
        {passkeysWork ? (
          <Button
            disabled={busy}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setMethod(method === "passkey" ? "password" : "passkey");
              setError("");
            }}
          >
            {method === "passkey" ? "Use a password instead" : "Use a passkey instead"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

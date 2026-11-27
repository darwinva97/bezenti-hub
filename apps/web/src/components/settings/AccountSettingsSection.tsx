import { type AuthAccount, AuthLoginName, type AuthTotpEnrollment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  confirmTotpEnrollment,
  fetchAccount,
  removeCredential,
  setAccountPassword,
  signOut,
  type StepUp,
  startKeycloak,
  startTotpEnrollment,
} from "../../environments/primary/userAccounts";
import { keycloakResultMessage, signedOutLocation } from "../auth/keycloakSignIn.logic";
import { errorMessageOf } from "../../lib/errorMessage";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { GitHubAccountRow } from "./GitHubAccountRow";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const isLoginName = Schema.is(AuthLoginName);

const stripSpaces = (code: string) => code.replace(/\s/g, "");

type AccountLoad =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "loaded"; readonly account: AuthAccount };

const loadAccount = (setLoad: (load: AccountLoad) => void, isCurrent: () => boolean) =>
  fetchAccount().then(
    (account) => {
      if (isCurrent()) setLoad({ status: "loaded", account });
    },
    (cause: unknown) => {
      if (isCurrent()) {
        setLoad({
          status: "failed",
          message: errorMessageOf(cause, "Could not load your account."),
        });
      }
    },
  );

/** Shown only for sessions that belong to a User; pairing-link sessions have no account to leave. */
export function AccountSettingsSection() {
  const session = usePrimarySessionState();
  const userId =
    session.data?.authenticated === true && session.data.userId !== undefined
      ? session.data.userId
      : null;
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [load, setLoad] = useState<AccountLoad>({ status: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the account from the server for the signed-in User.
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    void loadAccount(setLoad, () => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (userId === null) return null;

  const handleSignOut = async () => {
    setIsSigningOut(true);
    const signedOut = await signOut().catch(() => ({ keycloakSignOutHandle: undefined }));
    // Ticket 07: from a Keycloak sign-in, the page offers to leave Keycloak too.
    window.location.replace(signedOutLocation(signedOut.keycloakSignOutHandle));
  };
  const onChanged = (account: AuthAccount) => setLoad({ status: "loaded", account });
  const keycloakOffered = session.data?.signInOptions?.keycloak === true;

  return (
    <SettingsSection {...searchableSetting("account")}>
      {load.status === "loaded" ? (
        <>
          <KeycloakRow account={load.account} offered={keycloakOffered} />
          {/* Who signs in with Keycloak keeps no local credentials, the Owner's break-glass aside. */}
          {load.account.identity === undefined || load.account.user.isOwner ? (
            <>
              <TotpRow account={load.account} onChanged={onChanged} />
              <PasswordRow account={load.account} onChanged={onChanged} />
            </>
          ) : null}
        </>
      ) : null}
      {load.status === "failed" ? (
        <SettingsRow
          title="Sign-in methods"
          description={load.message}
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setLoad({ status: "loading" });
                void loadAccount(setLoad, () => true);
              }}
            >
              Retry
            </Button>
          }
        />
      ) : null}
      {/* Makita ticket 08: the User's own linked GitHub account. */}
      <GitHubAccountRow />
      <SettingsRow
        title="Sign out"
        description={signOutDescription(load.status === "loaded" ? load.account : null)}
        control={
          <Button
            disabled={isSigningOut}
            size="xs"
            variant="outline"
            onClick={() => void handleSignOut()}
          >
            {isSigningOut ? "Signing out..." : "Sign out"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

export interface StepUpState {
  readonly usePasskey: boolean;
  readonly password: string;
  readonly code: string;
  /** A strong factor confirmed through Keycloak rather than here (`confirmWithKeycloak`). */
  readonly viaKeycloak: boolean;
}

/** A passkey, or a password with a code from an authenticator app: a password alone is refused. */
export const hasLocalStrongFactor = (account: AuthAccount) =>
  account.hasPasskey || account.totpEnrolled;

export const emptyStepUp = (account: AuthAccount): StepUpState => ({
  usePasskey: account.hasPasskey,
  password: "",
  code: "",
  viaKeycloak: account.identity !== undefined && !hasLocalStrongFactor(account),
});

/**
 * What a machine's loan asks for where the lender also decides: a local strong factor, or, for
 * who signs in with Keycloak, the second factor there.
 */
export const lacksStrongFactor = (account: AuthAccount) =>
  !hasLocalStrongFactor(account) && account.identity === undefined;

export const toStepUp = (account: AuthAccount, state: StepUpState): StepUp => {
  if (!account.hasPasskey && !account.hasPassword) return { method: "none" };
  if (state.usePasskey || !account.hasPassword) return { method: "passkey" };
  return {
    method: "password",
    password: state.password,
    ...(account.totpEnrolled ? { totpCode: stripSpaces(state.code) } : {}),
  };
};

/** Changing a sign-in method needs proof you can sign in now: your passkey, or password and code. */
export function StepUpFields({
  account,
  disabled,
  value,
  onChange,
}: {
  account: AuthAccount;
  disabled: boolean;
  value: StepUpState;
  onChange: (value: StepUpState) => void;
}) {
  if (!account.hasPasskey && !account.hasPassword) return null;
  if (value.usePasskey || !account.hasPassword) {
    return (
      <p className="text-xs text-muted-foreground">
        You will confirm it's you with your passkey.{" "}
        {account.hasPassword ? (
          <Button
            disabled={disabled}
            size="xs"
            variant="link"
            onClick={() => onChange({ ...value, usePasskey: false })}
          >
            Use your password instead
          </Button>
        ) : null}
      </p>
    );
  }
  return (
    <>
      <label className="text-xs font-medium" htmlFor="step-up-password">
        Current password
      </label>
      <Input
        id="step-up-password"
        autoComplete="current-password"
        disabled={disabled}
        nativeInput
        onChange={(event) => onChange({ ...value, password: event.currentTarget.value })}
        type="password"
        value={value.password}
      />
      {account.totpEnrolled ? (
        <>
          <label className="text-xs font-medium" htmlFor="step-up-code">
            Current code from your authenticator app
          </label>
          <Input
            id="step-up-code"
            autoComplete="one-time-code"
            disabled={disabled}
            inputMode="numeric"
            nativeInput
            onChange={(event) => onChange({ ...value, code: event.currentTarget.value })}
            placeholder="123456"
            value={value.code}
          />
        </>
      ) : null}
      {account.hasPasskey ? (
        <Button
          disabled={disabled}
          size="xs"
          variant="link"
          onClick={() => onChange({ ...value, usePasskey: true })}
        >
          Use your passkey instead
        </Button>
      ) : null}
    </>
  );
}

function ErrorNote({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="mt-3">
      <Alert variant="error">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
}

/** Runs one account change, tracking busy and error state for a row. */
function useAccountChange(onChanged: (account: AuthAccount) => void) {
  const [errorMessage, setErrorMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const run = async (change: () => Promise<AuthAccount>, onDone?: () => void) => {
    setIsBusy(true);
    setErrorMessage("");
    await change().then(
      (account) => {
        onDone?.();
        onChanged(account);
      },
      (cause: unknown) => setErrorMessage(errorMessageOf(cause, "That change did not go through.")),
    );
    setIsBusy(false);
  };
  return { errorMessage, setErrorMessage, isBusy, run };
}

function RemovalForm({
  account,
  label,
  onCancel,
  onRemove,
  isBusy,
}: {
  account: AuthAccount;
  label: string;
  onCancel: () => void;
  onRemove: (stepUp: StepUp) => void;
  isBusy: boolean;
}) {
  const [stepUp, setStepUp] = useState(() => emptyStepUp(account));
  return (
    <form
      className="mt-3 flex max-w-sm flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onRemove(toStepUp(account, stepUp));
      }}
    >
      <StepUpFields account={account} disabled={isBusy} value={stepUp} onChange={setStepUp} />
      <FormButtons isBusy={isBusy} submitLabel={label} onCancel={onCancel} />
    </form>
  );
}

function FormButtons({
  isBusy,
  submitDisabled = false,
  submitLabel,
  onCancel,
}: {
  isBusy: boolean;
  submitDisabled?: boolean;
  submitLabel: ReactNode;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button disabled={isBusy || submitDisabled} size="sm" type="submit">
        {submitLabel}
      </Button>
      <Button disabled={isBusy} size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** «Connect Keycloak», or the Keycloak account this User signs in with. */
/** What signing in again takes: Keycloak for who signs in with it, the passkey for the rest. */
function signOutDescription(account: AuthAccount | null) {
  const ends = "Ends this browser's session.";
  if (account?.identity === undefined)
    return `${ends} Sign in again with your passkey or password.`;
  return account.user.isOwner
    ? `${ends} Sign in again with Keycloak, or with your passkey.`
    : `${ends} Sign in again with Keycloak.`;
}

function KeycloakRow({ account, offered }: { account: AuthAccount; offered: boolean }) {
  const [connecting, setConnecting] = useState(false);
  const [stepUp, setStepUp] = useState(() => emptyStepUp(account));
  const [isBusy, setIsBusy] = useState(false);
  // A link Keycloak refused comes back here with `?keycloak=<why>`.
  const [errorMessage, setErrorMessage] = useState(
    () => keycloakResultMessage(window.location.search) ?? "",
  );
  const identity = account.identity;
  if (identity !== undefined) {
    const who = identity.username ?? identity.email ?? "your Keycloak account";
    return (
      <SettingsRow
        title="Keycloak"
        description={`You sign in with Keycloak as ${who}. Change your password or second factor there.`}
        control={
          <Button
            size="xs"
            variant="outline"
            render={<a href={identity.accountUrl} rel="noreferrer" target="_blank" />}
          >
            Keycloak account
          </Button>
        }
      />
    );
  }
  if (!offered) return null;
  const connect = async () => {
    setIsBusy(true);
    setErrorMessage("");
    await startKeycloak({
      intent: "link",
      returnTo: window.location.pathname,
      stepUp: toStepUp(account, stepUp),
    }).catch((cause: unknown) => {
      setErrorMessage(errorMessageOf(cause, "Could not connect Keycloak."));
      setIsBusy(false);
    });
  };
  return (
    <SettingsRow
      title="Keycloak"
      description={
        account.keycloakLink === "needs-reset"
          ? "Ask the Owner for a reset link to connect Keycloak to this account."
          : account.user.isOwner
            ? "Sign in with your Keycloak account. You keep your passkey and recovery codes."
            : "Sign in with your Keycloak account from now on. Your passkeys, password and authenticator app here are removed, and your other sessions end."
      }
      control={
        account.keycloakLink === "allowed" && !connecting ? (
          <Button size="xs" variant="outline" onClick={() => setConnecting(true)}>
            Connect Keycloak
          </Button>
        ) : null
      }
    >
      {connecting ? (
        <form
          className="mt-3 flex max-w-sm flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <StepUpFields account={account} disabled={isBusy} value={stepUp} onChange={setStepUp} />
          <FormButtons
            isBusy={isBusy}
            submitLabel="Continue to Keycloak"
            onCancel={() => {
              setConnecting(false);
              setStepUp(emptyStepUp(account));
              setErrorMessage("");
            }}
          />
        </form>
      ) : null}
      <ErrorNote message={errorMessage} />
    </SettingsRow>
  );
}

function TotpRow({
  account,
  onChanged,
}: {
  account: AuthAccount;
  onChanged: (account: AuthAccount) => void;
}) {
  const [mode, setMode] = useState<"idle" | "enrolling" | "removing">("idle");
  const [enrollment, setEnrollment] = useState<AuthTotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [stepUp, setStepUp] = useState(() => emptyStepUp(account));
  const { errorMessage, setErrorMessage, isBusy, run } = useAccountChange(onChanged);

  const close = () => {
    setMode("idle");
    setEnrollment(null);
    setCode("");
    setStepUp(emptyStepUp(account));
    setErrorMessage("");
  };

  const start = async () => {
    setErrorMessage("");
    await startTotpEnrollment().then(
      (started) => {
        setEnrollment(started);
        setMode("enrolling");
      },
      (cause: unknown) => setErrorMessage(errorMessageOf(cause, "Could not start the setup.")),
    );
  };

  return (
    <SettingsRow
      title="Authenticator app"
      description={
        account.totpEnrolled
          ? "Set up. Password sign-in asks for a code from this app."
          : account.passwordRequiresTotp
            ? "Not set up. Your account needs it before you can add a password."
            : "Not set up. Adds a code from an app such as 1Password or Google Authenticator to password sign-in."
      }
      control={
        mode === "idle" ? (
          <div className="flex gap-2">
            <Button disabled={isBusy} size="xs" variant="outline" onClick={() => void start()}>
              {account.totpEnrolled ? "Replace" : "Set up"}
            </Button>
            {account.totpEnrolled ? (
              <Button size="xs" variant="ghost" onClick={() => setMode("removing")}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {mode === "enrolling" && enrollment ? (
        <form
          className="mt-3 flex max-w-sm flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                confirmTotpEnrollment({
                  enrollmentId: enrollment.enrollmentId,
                  code: stripSpaces(code),
                  stepUp: toStepUp(account, stepUp),
                }),
              close,
            );
          }}
        >
          <p className="text-xs text-muted-foreground">
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
            Can't scan? Enter this key: <code className="select-all">{enrollment.secret}</code>
          </p>
          <Input
            aria-label="Code from your authenticator app"
            autoComplete="one-time-code"
            disabled={isBusy}
            inputMode="numeric"
            nativeInput
            onChange={(event) => setCode(event.currentTarget.value)}
            placeholder="123456"
            value={code}
          />
          <StepUpFields account={account} disabled={isBusy} value={stepUp} onChange={setStepUp} />
          <FormButtons
            isBusy={isBusy}
            submitDisabled={stripSpaces(code).length !== 6}
            submitLabel="Confirm"
            onCancel={close}
          />
        </form>
      ) : null}
      {mode === "removing" ? (
        <RemovalForm
          account={account}
          isBusy={isBusy}
          label="Remove authenticator app"
          onCancel={close}
          onRemove={(proof) => void run(() => removeCredential("totp", proof), close)}
        />
      ) : null}
      <ErrorNote message={errorMessage} />
    </SettingsRow>
  );
}

function PasswordRow({
  account,
  onChanged,
}: {
  account: AuthAccount;
  onChanged: (account: AuthAccount) => void;
}) {
  const [mode, setMode] = useState<"idle" | "editing" | "removing">("idle");
  const [loginName, setLoginName] = useState(account.loginName ?? "");
  const [password, setPassword] = useState("");
  const [stepUp, setStepUp] = useState(() => emptyStepUp(account));
  const { errorMessage, setErrorMessage, isBusy, run } = useAccountChange(onChanged);
  const blocked = account.passwordRequiresTotp && !account.totpEnrolled;

  const close = () => {
    setMode("idle");
    setPassword("");
    setStepUp(emptyStepUp(account));
    setErrorMessage("");
  };

  return (
    <SettingsRow
      title="Password"
      description={
        account.hasPassword
          ? `Set. Sign in as "${account.loginName ?? ""}". Changing it signs out your other devices.`
          : blocked
            ? "Set up an authenticator app first."
            : "Not set. A password lets you sign in where passkeys are not available."
      }
      control={
        mode === "idle" ? (
          <div className="flex gap-2">
            <Button
              disabled={blocked}
              size="xs"
              variant="outline"
              onClick={() => setMode("editing")}
            >
              {account.hasPassword ? "Change" : "Set password"}
            </Button>
            {account.hasPassword ? (
              <Button size="xs" variant="ghost" onClick={() => setMode("removing")}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {mode === "editing" ? (
        <form
          className="mt-3 flex max-w-sm flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isLoginName(loginName.trim())) {
              setErrorMessage(
                "Use 2 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.",
              );
              return;
            }
            void run(
              () => setAccountPassword({ loginName, password, stepUp: toStepUp(account, stepUp) }),
              close,
            );
          }}
        >
          <label className="text-xs font-medium" htmlFor="account-login-name">
            Sign-in name
          </label>
          <Input
            id="account-login-name"
            autoCapitalize="none"
            autoComplete="username"
            disabled={isBusy}
            nativeInput
            onChange={(event) => setLoginName(event.currentTarget.value)}
            spellCheck={false}
            value={loginName}
          />
          <label className="text-xs font-medium" htmlFor="account-new-password">
            New password (8 characters or more)
          </label>
          <Input
            id="account-new-password"
            autoComplete="new-password"
            disabled={isBusy}
            nativeInput
            onChange={(event) => setPassword(event.currentTarget.value)}
            type="password"
            value={password}
          />
          <StepUpFields account={account} disabled={isBusy} value={stepUp} onChange={setStepUp} />
          <FormButtons
            isBusy={isBusy}
            submitDisabled={loginName.trim().length < 2 || password.length < 8}
            submitLabel="Save"
            onCancel={close}
          />
        </form>
      ) : null}
      {mode === "removing" ? (
        <RemovalForm
          account={account}
          isBusy={isBusy}
          label="Remove password"
          onCancel={close}
          onRemove={(proof) => void run(() => removeCredential("password", proof), close)}
        />
      ) : null}
      <ErrorNote message={errorMessage} />
    </SettingsRow>
  );
}

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
  startTotpEnrollment,
} from "../../environments/primary/userAccounts";
import { errorMessageOf } from "../../lib/errorMessage";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
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
    await signOut().catch(() => undefined);
    window.location.replace("/sign-in");
  };
  const onChanged = (account: AuthAccount) => setLoad({ status: "loaded", account });

  return (
    <SettingsSection {...searchableSetting("account")}>
      {load.status === "loaded" ? (
        <>
          <TotpRow account={load.account} onChanged={onChanged} />
          <PasswordRow account={load.account} onChanged={onChanged} />
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
      <SettingsRow
        title="Sign out"
        description="Ends this browser's session. Sign in again with your passkey or password."
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
}

export const emptyStepUp = (account: AuthAccount): StepUpState => ({
  usePasskey: account.hasPasskey,
  password: "",
  code: "",
});

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

import {
  checkSignInSettings,
  fetchSignInSettings,
  updateSignInSettings,
} from "@t3tools/client-runtime/spaces/space-directory";
import type {
  KeycloakCheckResult,
  RegistrationMode,
  SignInSettings,
  UpdateSignInSettingsRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { SettingsPageContainer } from "./settingsLayout";
import {
  changesOf,
  checkLinesOf,
  clientUrlsOf,
  formOf,
  REGISTRATION_MODES,
  type SignInForm,
} from "./signInSettings.logic";

const SECRET_NOT_STORED =
  "The settings were saved, but the client secret could not be stored. Enter it again.";

/** The server's own words for a refusal; a secret it could not store, in ours. */
const errorOf = (cause: unknown, fallback: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  cause.reason === "sign_in_secret_not_stored"
    ? SECRET_NOT_STORED
    : messageOf(cause, fallback);

const fetchSettings = () =>
  runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchSignInSettings)));

type Pending = "save" | "check" | "toggle" | null;

/** The Hub refused a change until it is confirmed (409): a strong-list change that ends sign-ins. */
const isConflict = (cause: unknown): boolean => {
  const tagOf = (value: unknown) =>
    typeof value === "object" && value !== null && "_tag" in value ? value._tag : undefined;
  return (
    tagOf(cause) === "EnvironmentHttpConflictError" ||
    tagOf((cause as { readonly cause?: unknown } | null)?.cause) === "EnvironmentHttpConflictError"
  );
};

/** A change the Hub asked the Owner to confirm first, in its words (how many sign-ins end). */
interface ToConfirm {
  readonly message: string;
  readonly payload: UpdateSignInSettingsRequest;
  readonly kind: "save" | "toggle";
}

/** The sign-in settings as the Hub holds them, the Owner's unsaved edits, and saving. */
function useSignInSettings() {
  const [settings, setSettings] = useState<SignInSettings | null>(null);
  const [form, setForm] = useState<SignInForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [toConfirm, setToConfirm] = useState<ToConfirm | null>(null);

  const show = (next: SignInSettings) => {
    setSettings(next);
    setForm(formOf(next));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the sign-in settings from the server when the section opens
  useEffect(() => {
    let cancelled = false;
    void fetchSettings().then(
      (loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setForm(formOf(loaded));
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the sign-in settings."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (payload: UpdateSignInSettingsRequest, kind: "save" | "toggle") => {
    setPending(kind);
    setError(null);
    setToConfirm(null);
    let saved = false;
    try {
      show(
        await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) => updateSignInSettings(client, payload)),
          ),
        ),
      );
      saved = true;
    } catch (cause) {
      if (isConflict(cause) && payload.endLoginsConfirmed !== true) {
        // Nothing was saved: the Hub says how many sign-ins the change ends; the Owner decides.
        setToConfirm({
          message: messageOf(cause, "This change ends Keycloak sign-ins."),
          payload,
          kind,
        });
      } else {
        setError(errorOf(cause, "Could not save the sign-in settings."));
        // The row may be saved though its secret was refused: show what the Hub holds now.
        void fetchSettings().then(setSettings, () => undefined);
      }
    }
    setPending(null);
    return saved;
  };

  return {
    settings,
    form,
    setForm,
    show,
    error,
    setError,
    pending,
    setPending,
    save,
    toConfirm,
    setToConfirm,
  };
}

type SignInState = ReturnType<typeof useSignInSettings>;

function Loading({ title, state }: { readonly title: string; readonly state: SignInState }) {
  return (
    <SettingsPageContainer>
      <h2 className="text-base font-semibold">{title}</h2>
      {state.error === null ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <p className="text-destructive text-sm">{state.error}</p>
      )}
    </SettingsPageContainer>
  );
}

function SaveBar({
  state,
  settings,
  changes,
}: {
  readonly state: SignInState;
  readonly settings: SignInSettings;
  readonly changes: UpdateSignInSettingsRequest | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="compact"
          disabled={state.pending !== null || changes === null}
          onClick={() => {
            if (changes !== null) void state.save(changes, "save");
          }}
        >
          {state.pending === "save" ? "Saving..." : "Save"}
        </Button>
        {changes !== null ? (
          <Button
            type="button"
            size="compact"
            variant="ghost"
            disabled={state.pending !== null}
            onClick={() => state.show(settings)}
          >
            Discard
          </Button>
        ) : null}
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.toConfirm !== null ? (
        <Alert variant="warning">
          <AlertDescription>
            <span>{state.toConfirm.message}</span>
            <span className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="compact"
                variant="destructive"
                disabled={state.pending !== null}
                onClick={() => {
                  const { payload, kind } = state.toConfirm ?? {};
                  if (payload !== undefined && kind !== undefined) {
                    void state.save({ ...payload, endLoginsConfirmed: true }, kind);
                  }
                }}
              >
                End them and save
              </Button>
              <Button
                type="button"
                size="compact"
                variant="ghost"
                disabled={state.pending !== null}
                onClick={() => state.setToConfirm(null)}
              >
                Cancel
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/**
 * Who may get a User, and whether everyone but the Owner may still sign in locally (Keycloak
 * sign-in, ticket 01). Saved now; tickets 03 and 08 make them take effect.
 */
export function PlatformRegistrationSection() {
  const state = useSignInSettings();
  const { settings, form } = state;
  if (settings === null || form === null) return <Loading title="Registration" state={state} />;
  const changes = changesOf(settings, form);
  const edit = (patch: Partial<SignInForm>) => state.setForm({ ...form, ...patch });

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Registration</h2>
        <p className="text-sm text-muted-foreground">
          Who may get a User on this Hub when they sign in with Keycloak, whatever Keycloak lets
          them do. Platform invitations and mapped groups arrive in later updates.
        </p>
      </div>
      <RadioGroup
        aria-label="Registration mode"
        value={form.registrationMode}
        onValueChange={(value) => edit({ registrationMode: value as RegistrationMode })}
      >
        {REGISTRATION_MODES.map((mode) => (
          <label key={mode.value} className="flex items-start gap-2 text-sm">
            <Radio value={mode.value} aria-label={mode.label} className="mt-0.5" />
            <span className="flex flex-col">
              <span>{mode.label}</span>
              <span className="text-xs text-muted-foreground">{mode.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {form.registrationMode === "open" ? (
        <Alert variant="warning">
          <AlertDescription>
            The terms of use that people accept when they sign up are not in place yet. Keep
            registration open only on a Hub that is not public, until they are.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Local sign-in for everyone but you"
            checked={form.localSignInForMembers}
            onCheckedChange={(on) => edit({ localSignInForMembers: on })}
          />
          Local sign-in (passkey or password) for everyone but you
        </label>
        <p className="text-xs text-muted-foreground">
          {settings.keycloak.enabled
            ? "You always keep your own passkey and recovery codes."
            : "Turn Keycloak on before turning this off: until then it is the only way in."}
        </p>
      </div>
      <SaveBar state={state} settings={settings} changes={changes} />
    </SettingsPageContainer>
  );
}

/**
 * The Keycloak client (Keycloak sign-in, ticket 01): issuer, client id and write-only secret,
 * «Check», the URLs to paste into Keycloak, and «Active», which turns on only past a Check.
 */
export function PlatformKeycloakSection() {
  const state = useSignInSettings();
  const [replacingSecret, setReplacingSecret] = useState(false);
  const [checked, setChecked] = useState<KeycloakCheckResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const { settings, form } = state;
  if (settings === null || form === null) return <Loading title="Keycloak" state={state} />;

  const changes = changesOf(settings, form);
  const keycloak = settings.keycloak;
  const { fromPage, urls } = clientUrlsOf(settings.publicOrigin, window.location.origin);
  const edit = (patch: Partial<SignInForm>) => state.setForm({ ...form, ...patch });

  const save = async (payload: UpdateSignInSettingsRequest, kind: "save" | "toggle") => {
    if (await state.save(payload, kind)) setReplacingSecret(false);
  };

  const check = async () => {
    state.setPending("check");
    state.setError(null);
    setChecked(null);
    try {
      setChecked(
        await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(checkSignInSettings)),
        ),
      );
    } catch (cause) {
      state.setError(messageOf(cause, "Could not check the realm."));
    }
    state.setPending(null);
  };

  const copy = async (url: string) => {
    try {
      await writeTextToClipboard(url);
      setCopied(url);
    } catch {
      state.setError("Could not copy. Select the address and copy it by hand.");
    }
  };

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Keycloak</h2>
        <p className="text-sm text-muted-foreground">
          Connect the Hub to a Keycloak realm: people sign up and sign in there, and the Hub decides
          who gets a User.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Keycloak active"
            checked={keycloak.enabled}
            disabled={state.pending !== null || changes !== null}
            onCheckedChange={(enabled) => void save({ keycloakEnabled: enabled }, "toggle")}
          />
          Active
        </label>
        <p className="text-xs text-muted-foreground">
          {changes !== null
            ? "Save your changes before turning Keycloak on or off."
            : keycloak.enabled
              ? "Turning it off keeps this configuration."
              : "Turning it on checks the realm first, and it stays off if the check fails."}
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Issuer
        <Input
          size="sm"
          aria-label="Issuer"
          placeholder="https://auth.example.com/realms/acme"
          value={form.issuer}
          onChange={(event) => edit({ issuer: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">
          The realm's address, exactly as Keycloak names it in its issuer.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Client ID
        <Input
          size="sm"
          aria-label="Client ID"
          value={form.clientId}
          onChange={(event) => edit({ clientId: event.target.value })}
        />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span>Client secret</span>
        {replacingSecret || !keycloak.clientSecretSet ? (
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            aria-label="Client secret"
            placeholder={keycloak.clientSecretSet ? "New client secret" : ""}
            value={form.clientSecret}
            onChange={(event) => edit({ clientSecret: event.target.value })}
          />
        ) : (
          <div className="flex items-center gap-2">
            <Badge variant="outline">Saved</Badge>
            {keycloak.clientSecretUpdatedAt !== null ? (
              <span className="text-xs text-muted-foreground">
                {new Date(keycloak.clientSecretUpdatedAt).toLocaleString()}
              </span>
            ) : null}
            <Button
              type="button"
              size="compact"
              variant="outline"
              onClick={() => setReplacingSecret(true)}
            >
              Replace
            </Button>
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          Write-only: once saved, nobody can read it from the Hub, you included.
        </span>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm">Strong factor</legend>
        <p className="text-xs text-muted-foreground">
          The Owner and Admins need a Keycloak sign-in with a second factor: one whose `acr` is in
          the first list, or with an `amr` value in the second. Exact values only. Empty lists: no
          Keycloak sign-in is strong, and the Owner and Admins can't sign in with Keycloak.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          acr values
          <Input
            size="sm"
            aria-label="Strong acr values"
            placeholder="critica"
            value={form.strongAcr}
            onChange={(event) => edit({ strongAcr: event.target.value })}
          />
          <span className="text-xs text-muted-foreground">
            The realm's level of authentication for MFA, e.g. `critica`; «Check» lists the realm's.
            Sign-ins that need a second factor ask Keycloak for these.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          amr values
          <Input
            size="sm"
            aria-label="Strong amr values"
            placeholder="otp, webauthn"
            value={form.strongAmr}
            onChange={(event) => edit({ strongAmr: event.target.value })}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Saving a change ends the Keycloak sign-ins of the Owner and Admins that no longer count as
          strong; the Hub tells you how many first.
        </p>
      </fieldset>
      <SaveBar state={state} settings={settings} changes={changes} />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="compact"
            variant="outline"
            disabled={state.pending !== null || keycloak.issuer === null || changes !== null}
            onClick={() => void check()}
          >
            {state.pending === "check" ? "Checking..." : "Check"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Fetches the saved realm's discovery document and keys.
          </span>
        </div>
        {checked !== null ? (
          <ul
            aria-label="Check result"
            className={`flex flex-col gap-1 text-sm ${checked._tag === "failed" ? "text-destructive" : ""}`}
          >
            {checkLinesOf(checked).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="keycloak-client-urls">
        <h3 id="keycloak-client-urls" className="text-sm font-medium">
          Paste these into the Keycloak client
        </h3>
        {fromPage ? (
          <p className="text-xs text-muted-foreground">
            From the address you opened the Hub on. Set T3CODE_PUBLIC_URL to the address people use
            and these follow it.
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {urls.map((entry) => (
            <li key={entry.label} className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">
                {entry.label} (Keycloak: {entry.keycloakField})
              </span>
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs select-all">
                  {entry.url}
                </code>
                <Button
                  type="button"
                  size="compact"
                  variant="outline"
                  aria-label={`Copy the ${entry.label}`}
                  onClick={() => void copy(entry.url)}
                >
                  {copied === entry.url ? "Copied" : "Copy"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Also in the client: Client authentication on, Standard flow on, and Backchannel logout
          session required on.
        </p>
      </section>
    </SettingsPageContainer>
  );
}

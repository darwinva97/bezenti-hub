import type { AuthAccount, EnvironmentJoinRequestView, SpaceId } from "@t3tools/contracts";
import { readEnvironmentJoinPageRequest } from "@t3tools/shared/environmentJoin";
import { useEffect, useState } from "react";

import {
  approveEnvironmentJoin,
  denyEnvironmentJoin,
  fetchEnvironmentJoinRequest,
} from "~/environments/primary/hubEnvironments";
import { fetchAccount, startKeycloak } from "~/environments/primary/userAccounts";
import { errorMessageOf } from "~/lib/errorMessage";
import { emptyStepUp, StepUpFields, toStepUp } from "../settings/AccountSettingsSection";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { UsedBySelect } from "../settings/UsedBySelect";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import {
  confirmsWithKeycloak,
  keycloakProofOf,
  keycloakResultMessage,
} from "./keycloakSignIn.logic";
import { SignInSurface } from "./SignInSurface";

type Outcome = "approved" | "cancelled" | null;

/** What the form held when the page left to confirm through Keycloak, by join request. */
interface Stashed {
  readonly name: string;
  readonly use: "personal" | SpaceId;
}
const stashKey = (requestId: string) => `t3:register-environment:${requestId}`;

const stashForm = (requestId: string, form: Stashed) => {
  try {
    window.sessionStorage.setItem(stashKey(requestId), JSON.stringify(form));
  } catch {
    // Without storage the page comes back with the machine's own name; nothing is lost.
  }
};

const takeStashedForm = (requestId: string): Stashed | null => {
  try {
    const raw = window.sessionStorage.getItem(stashKey(requestId));
    window.sessionStorage.removeItem(stashKey(requestId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "name" in parsed &&
      "use" in parsed &&
      typeof parsed.name === "string" &&
      typeof parsed.use === "string"
    ) {
      return { name: parsed.name, use: parsed.use as Stashed["use"] };
    }
  } catch {
    // Unreadable: start from the machine's own name.
  }
  return null;
};

/**
 * The proof a Keycloak confirmation came back with, taken off the address at once (history too):
 * it serves this page once, and never stays where a copied link or a screenshot would carry it.
 */
const takeKeycloakProof = () => {
  const proofId = keycloakProofOf(window.location.hash);
  if (proofId !== null) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return proofId;
};

/**
 * The page `t3 join` links to, from any device. The Owner, or a User allowed to register their own
 * machines, checks the machine, may rename it, and confirms with a passkey or password and code.
 * `t3 join` learns the outcome by asking the Hub; a browser on that machine is also sent back to it.
 */
export function RegisterEnvironmentSurface({ signedIn }: { readonly signedIn: boolean }) {
  const [requestId] = useState(() => readEnvironmentJoinPageRequest(window.location.href));
  const [request, setRequest] = useState<EnvironmentJoinRequestView | null>(null);
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [name, setName] = useState("");
  // "personal", or the Organization the Owner dedicates it to.
  const [use, setUse] = useState<"personal" | SpaceId>("personal");
  const [stepUp, setStepUp] = useState<ReturnType<typeof emptyStepUp> | null>(null);
  const [pending, setPending] = useState(false);
  // A Keycloak confirmation that did not go through comes back with `?keycloak=<why>`.
  const [errorMessage, setErrorMessage] = useState(
    () => keycloakResultMessage(window.location.search) ?? "",
  );
  const [outcome, setOutcome] = useState<Outcome>(null);
  // Back from «Confirm with Keycloak»: the approval it left for resumes once, with this proof.
  const [keycloakProof] = useState(takeKeycloakProof);

  const decide = async (decision: () => Promise<string | null>, next: Outcome) => {
    setPending(true);
    setErrorMessage("");
    try {
      const redirectTo = await decision();
      // A browser on the machine itself goes back to `t3 join`; elsewhere this page says so.
      if (redirectTo !== null) window.location.replace(redirectTo);
      setOutcome(next);
    } catch (cause) {
      setErrorMessage(errorMessageOf(cause, "The machine could not be registered."));
    }
    setPending(false);
  };

  /** Leaves for Keycloak to confirm it's you; the form waits in this tab until the page is back. */
  const confirmWithKeycloak = (form: Stashed) => {
    if (requestId === null) return;
    setPending(true);
    setErrorMessage("");
    stashForm(requestId, form);
    startKeycloak({
      intent: "step-up",
      returnTo: `${window.location.pathname}${window.location.search}`,
      // Approving a machine needs a strong factor, whatever the Role.
      strongFactor: true,
    }).catch((cause: unknown) => {
      setErrorMessage(errorMessageOf(cause, "Could not start confirming with Keycloak."));
      setPending(false);
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the join request and the account's sign-in methods from the server.
  useEffect(() => {
    if (!signedIn || requestId === null) return;
    let current = true;
    void Promise.all([fetchEnvironmentJoinRequest(requestId), fetchAccount()]).then(
      ([loaded, loadedAccount]) => {
        if (!current) return;
        setRequest(loaded);
        setName(loaded.name ?? "");
        // `t3 join --dedicated <Space>` preselects that Space when the Hub found it.
        const requested = loaded.requestedDedicatedSpace?.toLowerCase();
        const asked = loaded.dedicatedSpaces?.[0];
        if (
          asked !== undefined &&
          (asked.id === loaded.requestedDedicatedSpace || asked.name.toLowerCase() === requested)
        ) {
          setUse(asked.id);
        }
        setAccount(loadedAccount);
        setStepUp(emptyStepUp(loadedAccount));
        if (keycloakProof === null) return;
        if (loaded.status !== "pending" || loaded.viewerMayApprove !== true) return;
        // Back from Keycloak: the form as it was left, approved at once with the proof.
        const form = takeStashedForm(requestId) ?? { name: loaded.name ?? "", use: "personal" };
        setName(form.name);
        setUse(form.use);
        if (form.name.trim() === "") return;
        setPending(true);
        approveEnvironmentJoin({
          requestId,
          name: form.name.trim(),
          stepUp: { method: "keycloak", proofId: keycloakProof },
          dedicatedSpaceId: loaded.dedicatedSpaces?.find((space) => space.id === form.use)?.id,
        })
          .then(
            (redirectTo) => {
              if (redirectTo !== null) window.location.replace(redirectTo);
              if (current) setOutcome("approved");
            },
            (cause: unknown) => {
              if (current) {
                setErrorMessage(errorMessageOf(cause, "The machine could not be registered."));
              }
            },
          )
          .finally(() => {
            if (current) setPending(false);
          });
      },
      (cause: unknown) => {
        if (current) setErrorMessage(errorMessageOf(cause, "Could not load this registration."));
      },
    );
    return () => {
      current = false;
    };
  }, [signedIn, requestId, keycloakProof]);

  const ended = (title: string, description: string) => (
    <StandalonePage>
      <StandalonePageHeader
        context="Register this machine"
        title={title}
        description={description}
      />
    </StandalonePage>
  );

  if (requestId === null) {
    return ended(
      "This registration cannot continue",
      "The link is incomplete or does not come from `t3 join`. Run `t3 join` on the machine again.",
    );
  }
  if (!signedIn) {
    return (
      <SignInSurface
        // The page reloads with the same request, now signed in.
        onSignedIn={() => window.location.reload()}
        description={
          <>
            Sign in to add your machine to{" "}
            <span className="font-medium text-foreground">{window.location.host}</span>.
          </>
        }
      />
    );
  }
  if (outcome === "approved") {
    return ended(
      "Approved",
      "Return to the machine's terminal and confirm there: `t3 join` registers it once you do. You can close this tab.",
    );
  }
  if (outcome === "cancelled") {
    return ended("Registration cancelled", "The machine was not added. You can close this tab.");
  }
  if (request !== null && request.status === "pending" && request.viewerMayApprove === false) {
    // Every active User adds their own machines; only an account turned off is refused.
    return ended(
      "This account can't add machines",
      request.denialMessage ?? "You may not add machines to this Hub.",
    );
  }
  // Signed in, yet the Hub could not tell who this is: never offer the form on a guess.
  if (request !== null && request.status === "pending" && request.viewerMayApprove !== true) {
    return (
      <SignInSurface
        onSignedIn={() => window.location.reload()}
        description={
          <>
            Sign in again to add your machine to{" "}
            <span className="font-medium text-foreground">{window.location.host}</span>.
          </>
        }
      />
    );
  }
  if (request !== null && request.status !== "pending") {
    return ended(
      request.status === "approved"
        ? "Machine registered"
        : request.status === "awaiting-confirmation"
          ? "Approved"
          : "Registration cancelled",
      request.status === "awaiting-confirmation"
        ? "This registration was approved and waits for the machine to confirm. You can close this tab."
        : "This registration was already decided. You can close this tab.",
    );
  }

  const dedicatedTo = request?.dedicatedSpaces?.find((space) => space.id === use);
  const viaKeycloak = account !== null && confirmsWithKeycloak(account);

  return (
    <StandalonePage>
      <StandalonePageHeader
        context={window.location.host}
        title="Register this machine"
        description={
          dedicatedTo === undefined
            ? "It becomes one of your personal Environments: only you run work on it. Only continue with a `t3 join` you just started."
            : `It becomes ${dedicatedTo.name}'s: its Members run that Space's work on it, inside a Sandbox container. Only continue with a \`t3 join\` you just started.`
        }
      />
      {request?.requestedDedicatedSpace !== undefined && request.dedicatedSpaces === undefined ? (
        <Alert className="mt-4" variant="warning">
          <AlertDescription>
            {`The machine asks to be dedicated to ${request.requestedDedicatedSpace}. Only the Owner dedicates machines; registering it here makes it your personal machine, which \`t3 join --dedicated\` refuses.`}
          </AlertDescription>
        </Alert>
      ) : null}
      {request === null && errorMessage === "" ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : null}
      {request !== null && account !== null && stepUp !== null ? (
        <form
          className="mt-6 flex max-w-sm flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (viaKeycloak) {
              confirmWithKeycloak({ name: name.trim(), use });
              return;
            }
            void decide(
              () =>
                approveEnvironmentJoin({
                  requestId,
                  name: name.trim(),
                  stepUp: toStepUp(account, stepUp),
                  dedicatedSpaceId: dedicatedTo?.id,
                }),
              "approved",
            );
          }}
        >
          <label className="text-xs font-medium" htmlFor="register-environment-name">
            Name
          </label>
          <Input
            id="register-environment-name"
            disabled={pending}
            maxLength={64}
            nativeInput
            onChange={(event) => setName(event.currentTarget.value)}
            value={name}
          />
          {request.dedicatedSpaces !== undefined ? (
            <>
              <label className="text-xs font-medium" htmlFor="register-environment-use">
                Used by
              </label>
              <UsedBySelect
                disabled={pending}
                id="register-environment-use"
                onChange={setUse}
                spaces={request.dedicatedSpaces}
                value={use}
              />
            </>
          ) : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Operating system</dt>
            <dd>{request.os}</dd>
            <dt className="text-muted-foreground">Hostname</dt>
            <dd>{request.hostname}</dd>
            <dt className="text-muted-foreground">Requested</dt>
            <dd>
              {request.requestedAt === undefined
                ? null
                : new Date(request.requestedAt).toLocaleString()}
            </dd>
          </dl>
          {viaKeycloak ? (
            <p className="text-xs text-muted-foreground">
              You will confirm it's you with Keycloak, with your second factor, and come back here.
            </p>
          ) : (
            <StepUpFields
              account={account}
              disabled={pending}
              value={stepUp}
              onChange={setStepUp}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || name.trim() === ""} type="submit">
              {pending
                ? "Registering…"
                : viaKeycloak
                  ? "Confirm with Keycloak"
                  : "Register this machine"}
            </Button>
            <Button
              disabled={pending}
              onClick={() => void decide(() => denyEnvironmentJoin(requestId), "cancelled")}
              variant="outline"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {errorMessage ? (
        <Alert className="mt-4" variant="error">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
    </StandalonePage>
  );
}

import type { AuthAccount, EnvironmentJoinRequestView, SpaceId } from "@t3tools/contracts";
import { readEnvironmentJoinPageRequest } from "@t3tools/shared/environmentJoin";
import { useEffect, useState } from "react";

import {
  approveEnvironmentJoin,
  denyEnvironmentJoin,
  fetchEnvironmentJoinRequest,
} from "~/environments/primary/hubEnvironments";
import { fetchAccount } from "~/environments/primary/userAccounts";
import { errorMessageOf } from "~/lib/errorMessage";
import { emptyStepUp, StepUpFields, toStepUp } from "../settings/AccountSettingsSection";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { UsedBySelect } from "../settings/UsedBySelect";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { SignInSurface } from "./SignInSurface";

type Outcome = "approved" | "cancelled" | null;

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
  const [errorMessage, setErrorMessage] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);

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
      },
      (cause: unknown) => {
        if (current) setErrorMessage(errorMessageOf(cause, "Could not load this registration."));
      },
    );
    return () => {
      current = false;
    };
  }, [signedIn, requestId]);

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
          <StepUpFields account={account} disabled={pending} value={stepUp} onChange={setStepUp} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || name.trim() === ""} type="submit">
              {pending ? "Registering…" : "Register this machine"}
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

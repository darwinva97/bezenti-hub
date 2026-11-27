import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AuthAccount, EnvironmentId, GrantOfferPreview } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { claimGrantOffer } from "../../environments/primary/grants";
import { fetchAccount, type StepUp } from "../../environments/primary/userAccounts";
import { errorMessageOf } from "../../lib/errorMessage";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { grantsEnvironment } from "../../state/grants";
import { useAtomCommand } from "../../state/use-atom-command";
import { confirmWithKeycloak, takeKeycloakStepUp } from "../auth/keycloakStepUp";
import {
  emptyStepUp,
  lacksStrongFactor,
  type StepUpState,
  toStepUp,
} from "../settings/AccountSettingsSection";
import { StrongFactorFields } from "../settings/StrongFactorFields";
import {
  limitsText,
  offerSpaceLabel,
  offerWarnings,
  spaceLabel,
} from "@t3tools/client-runtime/grants-view";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { forgetGrantOfferToken, takeGrantOfferToken } from "./grantOfferLink";

type Valid = Extract<GrantOfferPreview, { status: "valid" }>;
type OfferSpace = Valid["spaces"][number];

const DEAD = {
  title: "This lending link no longer works",
  description:
    "A lending link works once, for 7 days, until its lender cancels it. Ask them for a new one.",
};

/**
 * Where a lending link lands (Grants ticket 06): what is lent, by whom, with which caps and
 * warnings, and the Spaces where the User decides on loans. Applying it there accepts the loan.
 * Signed out, it asks to sign in first and keeps the link for after.
 */
export function GrantOfferSurface({ signedIn }: { readonly signedIn: boolean }) {
  // The fragment never reaches the server; read it once, then drop it from the address bar.
  const [token] = useState(takeGrantOfferToken);
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();

  if (token === null) {
    return (
      <StandalonePage>
        <StandalonePageHeader {...DEAD} />
      </StandalonePage>
    );
  }
  if (!signedIn) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title="Sign in to see this loan"
          description="Someone lent you a resource with a link. Sign in, and this page opens again with it."
        />
        <div className="mt-6">
          <Button onClick={() => void navigate({ to: "/sign-in" })}>Sign in</Button>
        </div>
      </StandalonePage>
    );
  }
  if (environmentId === null) {
    return (
      <StandalonePage>
        <StandalonePageHeader title="Checking the link" description="One moment..." />
      </StandalonePage>
    );
  }
  return <GrantOffer environmentId={environmentId} token={token} />;
}

function GrantOffer({
  environmentId,
  token,
}: {
  readonly environmentId: EnvironmentId;
  readonly token: string;
}) {
  const readOffer = useAtomCommand(grantsEnvironment.readOffer, "read a lending link");
  const claimOffer = useAtomCommand(grantsEnvironment.claimOffer, "apply a lending link");
  const navigate = useNavigate();
  // Right after a page load the session is not up yet: wait for it, then read.
  const connected = useEnvironment(environmentId)?.connection.phase === "connected";
  // Back from «Confirm with Keycloak»: the Space it was left for, applied once with the proof.
  const [resume] = useState(() => takeKeycloakStepUp("claim-offer"));
  const resumed = useRef(false);
  const [preview, setPreview] = useState<GrantOfferPreview | null>(null);
  const [spaceId, setSpaceId] = useState<string>(resume?.pending.spaceId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(
    resume !== null && "failure" in resume ? resume.failure : null,
  );
  const [done, setDone] = useState<string | null>(null);
  // Grants ticket 15: a machine's link asks the decider's strong factor, as accepting one does.
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [stepUp, setStepUp] = useState<StepUpState | null>(null);

  const claim = async (into: OfferSpace, machine: boolean, run: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await run();
      forgetGrantOfferToken();
      setDone(
        machine
          ? `Lent to ${spaceLabel(into)}: its Threads can run in a Sandbox on it now.`
          : `Lent to ${spaceLabel(into)}: its Threads can use it now.`,
      );
    } catch (cause) {
      setError(errorMessageOf(cause, "The link did not apply."));
    } finally {
      setPending(false);
    }
  };
  // Over HTTP, with the strong factor: applying a machine's link makes the loan active.
  const claimMachine = (into: OfferSpace, proof: StepUp) =>
    claim(into, true, () => claimGrantOffer({ token, spaceId: into.spaceId }, proof));

  const load = useEffectEvent(() => readOffer({ environmentId, input: { token } }));
  const show = useEffectEvent((read: Awaited<ReturnType<typeof readOffer>>) => {
    if (read._tag !== "Success") {
      setError(errorMessageOf(squashAtomCommandFailure(read), "Could not read this link."));
      return;
    }
    if (read.value.status === "invalid") forgetGrantOfferToken();
    setPreview(read.value);
    if (read.value.status === "valid" && resume !== null && "proofId" in resume) {
      if (resumed.current) return;
      resumed.current = true;
      const chosen = read.value.spaces.find((space) => space.spaceId === resume.pending.spaceId);
      const proof = { method: "keycloak", proofId: resume.proofId } as const;
      if (chosen !== undefined) void claimMachine(chosen, proof);
    }
    if (read.value.status === "valid" && read.value.resource.kind === "environment") {
      void fetchAccount().then(
        (found) => {
          setAccount(found);
          setStepUp(emptyStepUp(found));
        },
        (cause: unknown) => setError(errorMessageOf(cause, "Could not read your account.")),
      );
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the Hub what the link lends once the session is up.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void load().then((read) => {
      if (!cancelled) show(read);
    });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  if (preview === null) {
    return (
      <StandalonePage>
        <StandalonePageHeader title="Checking the link" description="One moment..." />
        {error === null ? null : <ErrorNote message={error} />}
      </StandalonePage>
    );
  }
  if (preview.status === "invalid") {
    return (
      <StandalonePage>
        <StandalonePageHeader {...DEAD} />
      </StandalonePage>
    );
  }
  const offer: Valid = preview;
  const chosen = offer.spaces.find((space) => space.spaceId === spaceId);
  const machine = offer.resource.kind === "environment";
  // A machine's link cannot be applied without a strong factor: none enrolled, or not read yet.
  const factorMissing = machine && (account === null || lacksStrongFactor(account));

  const apply = async () => {
    if (chosen === undefined || chosen.alreadyGranted) return;
    if (machine) {
      if (account === null || stepUp === null) return;
      if (!stepUp.viaKeycloak) return claimMachine(chosen, toStepUp(account, stepUp));
      setPending(true);
      setError(null);
      await confirmWithKeycloak({ kind: "claim-offer", spaceId: chosen.spaceId }).catch(
        (cause: unknown) => {
          setError(errorMessageOf(cause, "Could not start confirming with Keycloak."));
          setPending(false);
        },
      );
      return;
    }
    await claim(chosen, false, async () => {
      const claimed = await claimOffer({
        environmentId,
        input: { token, spaceId: chosen.spaceId },
      });
      if (claimed._tag !== "Success") throw squashAtomCommandFailure(claimed);
    });
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={`${offer.lender.name ?? "Someone"} lends you ${offer.resource.name}`}
        description={`${machine ? "A machine: your Space gets a Sandbox of its own on it" : "An AI account for your Threads, through the AI gateway"} · ${limitsText(offer.limits)}. The link works once, until ${new Date(offer.expiresAt).toLocaleString()}.`}
      />
      <div className="mt-6 flex flex-col gap-3">
        {offerWarnings(offer).map((warning) => (
          <p key={warning} className="text-sm text-warning" role="note">
            {warning}
          </p>
        ))}
        {done !== null ? (
          <>
            <p className="text-sm" role="status">
              {done}
            </p>
            <div>
              <Button onClick={() => void navigate({ to: "/" })}>Go to your Threads</Button>
            </div>
          </>
        ) : offer.spaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You decide on loans in none of your Spaces here: only an Organization's Admins, or a
            Personal space's owner, accept one.
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium">
              Lend it to
              <Select value={spaceId} onValueChange={(next) => setSpaceId(String(next ?? ""))}>
                <SelectTrigger aria-label="Lend it to">
                  <SelectValue>{chosen ? offerSpaceLabel(chosen) : "Choose a Space"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {offer.spaces.map((space) => (
                    <SelectItem
                      key={space.spaceId}
                      value={space.spaceId}
                      disabled={space.alreadyGranted}
                    >
                      {offerSpaceLabel(space)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            {machine && account !== null && stepUp !== null ? (
              <StrongFactorFields
                account={account}
                disabled={pending}
                value={stepUp}
                onChange={setStepUp}
                onOpenAccount={() =>
                  void navigate({ to: "/settings/user/$section", params: { section: "account" } })
                }
              />
            ) : null}
            <div>
              <Button
                disabled={pending || chosen === undefined || chosen.alreadyGranted || factorMissing}
                onClick={() => void apply()}
              >
                {!machine
                  ? "Accept the loan"
                  : stepUp?.viaKeycloak === true
                    ? "Confirm with Keycloak"
                    : "Confirm and accept"}
              </Button>
            </div>
          </>
        )}
        {error === null ? null : <ErrorNote message={error} />}
      </div>
    </StandalonePage>
  );
}

function ErrorNote({ message }: { readonly message: string }) {
  return (
    <Alert variant="error">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

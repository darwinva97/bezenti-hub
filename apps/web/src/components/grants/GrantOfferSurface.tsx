import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GrantOfferPreview } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { grantsEnvironment } from "../../state/grants";
import { useAtomCommand } from "../../state/use-atom-command";
import { limitsText, offerSpaceLabel, offerWarnings, spaceLabel } from "../settings/grantText";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { forgetGrantOfferToken, takeGrantOfferToken } from "./grantOfferLink";

type Valid = Extract<GrantOfferPreview, { status: "valid" }>;

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
  const [preview, setPreview] = useState<GrantOfferPreview | null>(null);
  const [spaceId, setSpaceId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useEffectEvent(() => readOffer({ environmentId, input: { token } }));
  const show = useEffectEvent((read: Awaited<ReturnType<typeof readOffer>>) => {
    if (read._tag !== "Success") {
      setError(errorMessageOf(squashAtomCommandFailure(read), "Could not read this link."));
      return;
    }
    if (read.value.status === "invalid") forgetGrantOfferToken();
    setPreview(read.value);
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

  const apply = async () => {
    if (chosen === undefined || chosen.alreadyGranted) return;
    setPending(true);
    setError(null);
    try {
      const claimed = await claimOffer({
        environmentId,
        input: { token, spaceId: chosen.spaceId },
      });
      if (claimed._tag !== "Success") throw squashAtomCommandFailure(claimed);
      forgetGrantOfferToken();
      setDone(`Lent to ${spaceLabel(chosen)}: its Threads can use it now.`);
    } catch (cause) {
      setError(errorMessageOf(cause, "The link did not apply."));
    } finally {
      setPending(false);
    }
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={`${offer.lender.name ?? "Someone"} lends you ${offer.resource.name}`}
        description={`An AI account for your Threads, through the AI gateway · ${limitsText(offer.limits)}. The link works once, until ${new Date(offer.expiresAt).toLocaleString()}.`}
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
            <div>
              <Button
                disabled={pending || chosen === undefined || chosen.alreadyGranted}
                onClick={() => void apply()}
              >
                Accept the loan
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

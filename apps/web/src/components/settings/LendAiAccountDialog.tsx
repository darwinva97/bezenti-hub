import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AiAccountGrantLimits,
  AiAccountSummary,
  EnvironmentId,
  GrantTarget,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { giveGrant } from "../../environments/primary/grants";
import { errorMessageOf } from "../../lib/errorMessage";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { grantsEnvironment } from "../../state/grants";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { spaceLabel, subscriptionTermsWarning } from "./GrantsSettings";

const NO_CAP: AiAccountGrantLimits = { kind: "ai-account", tokens: null, requests: null };

/**
 * «Lend…» on an AI account the User manages (their own, or an Organization's they run): the Space
 * among those they may lend to. Its Threads use it through the AI gateway; a direct account is
 * never offered. A loan where the lender also decides starts active, with no strong factor.
 */
export function LendAiAccountDialog({
  account,
  onClose,
}: {
  readonly account: AiAccountSummary;
  readonly onClose: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const targetsCommand = useAtomCommand(grantsEnvironment.targets, "list where you may lend");
  const [targets, setTargets] = useState<ReadonlyArray<GrantTarget> | null>(null);
  const [spaceId, setSpaceId] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const loadTargets = useEffectEvent((target: EnvironmentId) =>
    targetsCommand({
      environmentId: target,
      input: { resource: { kind: "ai-account", aiAccountId: account.id } },
    }),
  );
  const applyTargets = useEffectEvent((found: Awaited<ReturnType<typeof targetsCommand>>) => {
    if (found._tag === "Success") setTargets(found.value.targets);
    else setError(errorMessageOf(squashAtomCommandFailure(found), "Could not list the Spaces."));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads where the account may be lent when the dialog opens.
  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    void loadTargets(environmentId).then((found) => {
      if (!cancelled) applyTargets(found);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const target = targets?.find((entry) => entry.spaceId === spaceId);

  const submit = async () => {
    if (target === undefined) return;
    setPending(true);
    setError(null);
    try {
      const grant = await giveGrant(
        {
          resource: { kind: "ai-account", aiAccountId: account.id },
          spaceId: target.spaceId,
          limits: NO_CAP,
        },
        undefined,
      );
      setDone(
        grant.state === "active"
          ? `Lent to ${spaceLabel(target)}.`
          : `Waiting for ${spaceLabel(target)} to accept it.`,
      );
    } catch (cause) {
      setError(errorMessageOf(cause, "The loan did not go through."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Lend {account.name}</DialogTitle>
            <DialogDescription>
              The Space's Threads can use it through the AI gateway, after the Space's own accounts.
              You see how much each person there uses it, never their prompts or Threads, and you
              can take it back at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Lend to
                <Select value={spaceId} onValueChange={(next) => setSpaceId(String(next ?? ""))}>
                  <SelectTrigger aria-label="Lend to">
                    <SelectValue placeholder={targets === null ? "Loading…" : "Choose a Space"} />
                  </SelectTrigger>
                  <SelectPopup>
                    {(targets ?? []).map((entry) => (
                      <SelectItem key={entry.spaceId} value={entry.spaceId}>
                        {spaceLabel(entry)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              {account.type === "subscription" ? (
                <p className="text-xs text-warning" role="note">
                  {subscriptionTermsWarning(account.provider)}
                </p>
              ) : null}
              {target === undefined ? null : (
                <p className="text-xs text-muted-foreground">
                  {target.startsActive
                    ? "You also decide for this Space: the loan starts at once."
                    : "The loan waits until this Space accepts it."}
                </p>
              )}
              {done === null ? null : (
                <p className="text-xs" role="status">
                  {done}
                </p>
              )}
              {error === null ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button disabled={pending} type="button" variant="ghost" onClick={onClose}>
              {done === null ? "Cancel" : "Close"}
            </Button>
            {done === null ? (
              <Button disabled={pending || target === undefined} type="submit">
                Lend
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

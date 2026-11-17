import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AiAccountGrantLimits,
  AiAccountSummary,
  EnvironmentId,
  Grant,
  GrantCapPeriod,
  GrantTarget,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { giveGrant } from "../../environments/primary/grants";
import { errorMessageOf } from "../../lib/errorMessage";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { grantsEnvironment } from "../../state/grants";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { spaceLabel, subscriptionTermsWarning } from "./grantText";

const PERIODS: ReadonlyArray<readonly [GrantCapPeriod, string]> = [
  ["day", "a day"],
  ["week", "a week (from Monday)"],
  ["month", "a month"],
];

/** What the caps form holds, as typed. */
interface CapsDraft {
  readonly uncapped: boolean;
  readonly tokens: string;
  readonly tokensPeriod: GrantCapPeriod;
  readonly requests: string;
  readonly requestsPeriod: GrantCapPeriod;
}

const draftOf = (limits: AiAccountGrantLimits | null): CapsDraft => ({
  uncapped: limits !== null && limits.tokens === null,
  tokens: limits?.tokens === null || limits === null ? "" : String(limits.tokens.amount),
  tokensPeriod: limits?.tokens?.period ?? "day",
  requests: limits?.requests === null || limits === null ? "" : String(limits.requests.amount),
  requestsPeriod: limits?.requests?.period ?? "day",
});

const wholePositive = (text: string) => {
  const value = Number(text.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

/**
 * The caps as the Hub takes them, or why not: a token cap is required unless «No token cap» is
 * ticked; a request cap is optional (empty: none).
 */
const limitsOf = (draft: CapsDraft): AiAccountGrantLimits | string => {
  const tokens = draft.uncapped ? null : wholePositive(draft.tokens);
  if (tokens === undefined) return "Set a token cap, or tick «No token cap».";
  const requests = draft.requests.trim() === "" ? null : wholePositive(draft.requests);
  if (requests === undefined) return "A request cap is a whole number above 0, or empty.";
  return {
    kind: "ai-account",
    tokens: tokens === null ? null : { amount: tokens, period: draft.tokensPeriod },
    requests: requests === null ? null : { amount: requests, period: draft.requestsPeriod },
  };
};

function PeriodSelect(props: {
  readonly label: string;
  readonly value: GrantCapPeriod;
  readonly disabled: boolean;
  readonly onChange: (period: GrantCapPeriod) => void;
}) {
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(next) => props.onChange((next ?? "day") as GrantCapPeriod)}
    >
      <SelectTrigger aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {PERIODS.map(([period, words]) => (
          <SelectItem key={period} value={period}>
            {words}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * A loan's caps (Grants ticket 03): tokens (input, output and cache writes) per day, week or month,
 * or explicitly none; requests optionally. UTC periods; the gateway refuses a new request once a
 * cap is reached, so requests already running can pass it a little.
 */
function CapsFields(props: {
  readonly draft: CapsDraft;
  readonly disabled: boolean;
  readonly onChange: (draft: CapsDraft) => void;
}) {
  const { draft } = props;
  const set = (patch: Partial<CapsDraft>) => props.onChange({ ...draft, ...patch });
  return (
    <fieldset className="flex flex-col gap-2 text-xs">
      <legend className="font-medium">Caps</legend>
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <label className="flex flex-col gap-1 font-medium" htmlFor="grant-cap-tokens">
          Tokens
          <Input
            id="grant-cap-tokens"
            inputMode="numeric"
            nativeInput
            disabled={props.disabled || draft.uncapped}
            value={draft.tokens}
            onChange={(event) => set({ tokens: event.currentTarget.value })}
          />
        </label>
        <PeriodSelect
          label="Token cap period"
          value={draft.tokensPeriod}
          disabled={props.disabled || draft.uncapped}
          onChange={(tokensPeriod) => set({ tokensPeriod })}
        />
      </div>
      <label className="flex items-center gap-2">
        <Checkbox
          aria-label="No token cap"
          checked={draft.uncapped}
          disabled={props.disabled}
          onCheckedChange={(checked) => set({ uncapped: checked === true })}
        />
        No token cap: the Space may use it as much as it wants
      </label>
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <label className="flex flex-col gap-1 font-medium" htmlFor="grant-cap-requests">
          Requests (optional)
          <Input
            id="grant-cap-requests"
            inputMode="numeric"
            nativeInput
            disabled={props.disabled}
            value={draft.requests}
            onChange={(event) => set({ requests: event.currentTarget.value })}
          />
        </label>
        <PeriodSelect
          label="Request cap period"
          value={draft.requestsPeriod}
          disabled={props.disabled}
          onChange={(requestsPeriod) => set({ requestsPeriod })}
        />
      </div>
      <p className="text-muted-foreground">
        Tokens count input, output and cache writes. Periods are in UTC. A new request is refused
        once a cap is reached; requests already running finish.
      </p>
    </fieldset>
  );
}

/**
 * «Lend…» on an AI account the User manages (their own, or an Organization's they run): the Space
 * among those they may lend to and its caps. Its Threads use it through the AI gateway; a direct
 * account is never offered. A loan where the lender also decides starts active.
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
  const [draft, setDraft] = useState<CapsDraft>(draftOf(null));
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
  const limits = limitsOf(draft);

  const submit = async () => {
    if (target === undefined || typeof limits === "string") return;
    setPending(true);
    setError(null);
    try {
      const grant = await giveGrant(
        {
          resource: { kind: "ai-account", aiAccountId: account.id },
          spaceId: target.spaceId,
          limits,
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
              The Space's Threads can use it through the AI gateway, after the Space's own accounts,
              up to its caps. You see how much each person there uses it, never their prompts or
              Threads, and you can take it back at any time.
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
              <CapsFields draft={draft} disabled={pending || done !== null} onChange={setDraft} />
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
              <Button
                disabled={pending || target === undefined || typeof limits === "string"}
                type="submit"
              >
                Lend
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** The lender changes a loan's caps; below what was used, the next request is refused. */
export function ChangeCapsDialog({
  environmentId,
  grant,
  onClose,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly grant: Grant;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void>;
}) {
  const setLimits = useAtomCommand(grantsEnvironment.setLimits, "change a loan's caps");
  const [draft, setDraft] = useState<CapsDraft>(
    draftOf(grant.limits.kind === "ai-account" ? grant.limits : null),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limits = limitsOf(draft);

  const submit = async () => {
    if (typeof limits === "string") return;
    setPending(true);
    setError(null);
    try {
      const done = await setLimits({ environmentId, input: { grantId: grant.id, limits } });
      if (done._tag !== "Success") throw squashAtomCommandFailure(done);
      await onChanged();
      onClose();
    } catch (cause) {
      setError(errorMessageOf(cause, "The caps did not change."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Caps of {grant.resource.name ?? "this AI account"}</DialogTitle>
            <DialogDescription>
              Below what was already used this period, its next request is refused.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <CapsFields draft={draft} disabled={pending} onChange={setDraft} />
              {error === null ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button disabled={pending} type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={pending || typeof limits === "string"} type="submit">
              Save caps
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

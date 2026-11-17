import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AuthAccount,
  EnvironmentGrantLimits,
  EnvironmentId,
  Grant,
  GrantTarget,
  HubEnvironmentSummary,
  SandboxHostReport,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";

import { acceptGrant, giveGrant } from "../../environments/primary/grants";
import { fetchAccount } from "../../environments/primary/userAccounts";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { emptyStepUp, StepUpFields, toStepUp } from "./AccountSettingsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(bytes % GIB === 0 ? 0 : 1)} GiB`;

/** What a borrower is told before accepting, and what the lent machine shows: the spec's words. */
const lenderSeesEverything = (lender: string) =>
  `${lender} controls this machine and can see everything that runs on it: files, processes, the Secrets turns receive and each Thread's AI gateway key.`;

/** What the lender accepts by lending. */
const LENDER_RISKS = [
  "All the Sandboxes on this machine run as your Linux user: someone who breaks out of one has your account here, and can reach the other Sandboxes.",
  "Their traffic leaves from this machine's address and can reach your network.",
  "Disk is measured every minute, not capped: a Sandbox can go over its limit between two checks.",
];

const limitsText = (limits: EnvironmentGrantLimits) =>
  `${limits.cpus} CPUs · ${gib(limits.memoryBytes)} memory · ${limits.pids} processes · ${gib(limits.diskBytes)} disk`;

/** Which limits the machine's cgroups do not enforce, in words; null when it enforces them all. */
const unenforced = (host: SandboxHostReport) => {
  const missing = [
    host.limitSupport.cpus ? null : "CPU",
    host.limitSupport.memory ? null : "memory",
    host.limitSupport.pids ? null : "processes",
  ].filter((entry) => entry !== null);
  return missing.length === 0
    ? null
    : `On this machine these limits are not enforced: ${missing.join(", ")}.${host.limitSupport.note === null ? "" : ` ${host.limitSupport.note}`}`;
};

/** A machine's hosting state as its last report says it. */
function HostState({ host }: { readonly host: SandboxHostReport | null }) {
  if (host === null) {
    return (
      <p className="text-xs text-muted-foreground">
        This machine has not said yet whether it can run Sandboxes (it may run an older T3 Code).
        The loan is made, and works once it can.
      </p>
    );
  }
  const notEnforced = unenforced(host);
  return (
    <div className="flex flex-col gap-1 text-xs">
      {host.ready ? null : (
        <p className="text-destructive" role="alert">
          This machine cannot run a Sandbox for another Space now: {host.reason}
        </p>
      )}
      {notEnforced === null ? null : <p className="text-muted-foreground">{notEnforced}</p>}
      {host.reachablePorts.length === 0 ? null : (
        <p className="text-muted-foreground">
          Borrowing Spaces can reach these ports of this machine: {host.reachablePorts.join(", ")}.
        </p>
      )}
    </div>
  );
}

type StepUpState = ReturnType<typeof emptyStepUp>;

/**
 * «Lend…» on one of the User's personal machines: the Space, the limits, the lender's risks and
 * what the machine said of itself; a loan where the lender also decides starts active, with the
 * strong factor.
 */
export function LendMachineDialog({
  machine,
  onClose,
}: {
  readonly machine: HubEnvironmentSummary;
  readonly onClose: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const targetsCommand = useAtomCommand(grantsEnvironment.targets, "list where you may lend");
  const [targets, setTargets] = useState<ReadonlyArray<GrantTarget> | null>(null);
  const [host, setHost] = useState<SandboxHostReport | null>(null);
  const [spaceId, setSpaceId] = useState<string>("");
  const [cpus, setCpus] = useState("2");
  const [memory, setMemory] = useState("4");
  const [pids, setPids] = useState("4096");
  const [disk, setDisk] = useState("20");
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [stepUp, setStepUp] = useState<StepUpState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTargets = useEffectEvent((target: EnvironmentId) =>
    targetsCommand({
      environmentId: target,
      input: { resource: { kind: "environment", environmentId: machine.id } },
    }),
  );
  const applyTargets = useEffectEvent((found: Awaited<ReturnType<typeof targetsCommand>>) => {
    if (found._tag === "Success") {
      setTargets(found.value.targets);
      setHost(found.value.host);
    } else {
      setError(errorMessageOf(squashAtomCommandFailure(found), "Could not list the Spaces."));
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads where the machine may be lent when the dialog opens.
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
  const limits: EnvironmentGrantLimits = {
    kind: "environment",
    cpus: Number(cpus),
    memoryBytes: Math.round(Number(memory) * GIB),
    pids: Math.round(Number(pids)),
    diskBytes: Math.round(Number(disk) * GIB),
  };
  const valid =
    target !== undefined &&
    [limits.cpus, limits.memoryBytes, limits.pids, limits.diskBytes].every(
      (value) => Number.isFinite(value) && value > 0,
    );

  const submit = async () => {
    if (target === undefined) return;
    setPending(true);
    setError(null);
    try {
      if (target.startsActive && account === null) {
        // Lending where you also decide accepts it too: confirm with a strong factor first.
        const read = await fetchAccount();
        setAccount(read);
        setStepUp(emptyStepUp(read));
        return;
      }
      await giveGrant(
        {
          resource: { kind: "environment", environmentId: machine.id },
          spaceId: target.spaceId,
          limits,
        },
        target.startsActive && account !== null && stepUp !== null
          ? toStepUp(account, stepUp)
          : undefined,
      );
      onClose();
    } catch (cause) {
      setError(errorMessageOf(cause, "The loan did not go through."));
    } finally {
      setPending(false);
    }
  };

  const field = (id: string, label: string, value: string, set: (next: string) => void) => (
    <label className="flex flex-col gap-1 text-xs font-medium" htmlFor={id}>
      {label}
      <Input
        id={id}
        inputMode="decimal"
        nativeInput
        value={value}
        onChange={(event) => set(event.currentTarget.value)}
      />
    </label>
  );

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
            <DialogTitle>Lend {machine.name}</DialogTitle>
            <DialogDescription>
              The Space gets a Sandbox of its own on this machine, with these limits. You keep using
              the machine as before.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <HostState host={host} />
              <label className="flex flex-col gap-1 text-xs font-medium">
                Lend to
                <Select value={spaceId} onValueChange={(next) => setSpaceId(String(next ?? ""))}>
                  <SelectTrigger aria-label="Lend to">
                    <SelectValue placeholder={targets === null ? "Loading…" : "Choose a Space"} />
                  </SelectTrigger>
                  <SelectPopup>
                    {(targets ?? []).map((entry) => (
                      <SelectItem key={entry.spaceId} value={entry.spaceId}>
                        {entry.kind === "personal" ? `${entry.name} (personal)` : entry.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {field("grant-cpus", "CPUs", cpus, setCpus)}
                {field("grant-memory", "Memory (GiB)", memory, setMemory)}
                {field("grant-pids", "Processes and threads", pids, setPids)}
                {field("grant-disk", "Disk (GiB)", disk, setDisk)}
              </div>
              <div className="text-xs">
                <p className="font-medium">What you accept by lending</p>
                <ul className="list-disc pl-4 text-muted-foreground">
                  {LENDER_RISKS.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              </div>
              {target === undefined ? null : (
                <p className="text-xs text-muted-foreground">
                  {target.startsActive
                    ? "You also decide for this Space: the loan starts at once, after you confirm it's you."
                    : "The loan waits until this Space accepts it."}
                </p>
              )}
              {account !== null && stepUp !== null ? (
                <StepUpFields
                  account={account}
                  disabled={pending}
                  value={stepUp}
                  onChange={setStepUp}
                />
              ) : null}
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
            <Button disabled={pending || !valid || host?.ready === false} type="submit">
              {target?.startsActive === true && account !== null ? "Confirm and lend" : "Lend"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const STATE_LABELS: Record<Grant["state"], string> = {
  offered: "Offered",
  pending: "Waiting for the Space",
  active: "Lent",
  rejected: "Rejected",
  cancelled: "Cancelled",
  ended: "Ended",
};

const END_LABELS: Record<NonNullable<Grant["endReason"]>, string> = {
  revoked: "taken back",
  returned: "given back",
  "resource-gone": "the machine was removed",
  "target-gone": "the Space was deleted",
  "lender-gone": "the lender left",
  "owner-changed": "the machine changed owner",
};

/** One loan's limits, Sandbox state and disk, as both sides see them. */
const loanDescription = (grant: Grant, side: "given" | "received") => {
  const where =
    side === "given"
      ? `to ${grant.target?.name ?? "a Space"}`
      : `by ${grant.lender.name ?? "another User"}`;
  const parts = [
    `${STATE_LABELS[grant.state]}${grant.endReason === null ? "" : ` (${END_LABELS[grant.endReason]})`} ${where}`,
    limitsText(grant.limits),
  ];
  const machine = grant.machine;
  if (machine !== undefined && grant.state === "active") {
    if (machine.sandboxState !== null) {
      parts.push(
        `Sandbox ${machine.sandboxState}${machine.sandboxMessage === null ? "" : `: ${machine.sandboxMessage}`}`,
      );
    }
    if (machine.diskUsedBytes !== null) parts.push(`${gib(machine.diskUsedBytes)} disk used`);
    if (machine.host !== null && !machine.host.ready) {
      parts.push(`The machine cannot run it now: ${machine.host.reason ?? "unknown"}`);
    }
  }
  return parts.join(" · ");
};

/**
 * Settings → Environments → «Loans»: machines the User lent (take back, cancel), loans waiting for
 * a Space they decide for (accept with a strong factor, reject) and machines their Spaces borrow
 * (give back). Never another Space's Threads.
 */
export function GrantsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <GrantsSection environmentId={environmentId} />;
}

function GrantsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const commands = {
    listGiven: useAtomCommand(grantsEnvironment.listGiven, "list your loans"),
    listReceived: useAtomCommand(grantsEnvironment.listReceived, "list your Spaces' loans"),
    reject: useAtomCommand(grantsEnvironment.reject, "reject a loan"),
    cancel: useAtomCommand(grantsEnvironment.cancel, "cancel a loan"),
    end: useAtomCommand(grantsEnvironment.end, "end a loan"),
  };
  const mayChange = useAtomValue(grantsEnvironment.end.permissionAtom(environmentId));
  const [given, setGiven] = useState<ReadonlyArray<Grant> | null>(null);
  const [received, setReceived] = useState<ReadonlyArray<Grant> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [accepting, setAccepting] = useState<{
    readonly grant: Grant;
    readonly account: AuthAccount;
    readonly stepUp: StepUpState;
  } | null>(null);
  const [ending, setEnding] = useState<Grant | null>(null);

  const fetchLoans = (target: EnvironmentId) =>
    Promise.all([
      commands.listGiven({ environmentId: target, input: {} }),
      commands.listReceived({ environmentId: target, input: {} }),
    ]);
  const showLoans = ([mine, ours]: Awaited<ReturnType<typeof fetchLoans>>) => {
    if (mine._tag === "Success") setGiven(mine.value.grants);
    if (ours._tag === "Success") setReceived(ours.value.grants);
    const failed = mine._tag === "Success" ? ours : mine;
    setError(
      failed._tag === "Success"
        ? null
        : errorMessageOf(squashAtomCommandFailure(failed), "Could not read the loans."),
    );
  };
  const loadLoans = useEffectEvent(fetchLoans);
  const applyLoans = useEffectEvent(showLoans);
  const reload = async () => showLoans(await fetchLoans(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the User's loans from the Hub when the section opens.
  useEffect(() => {
    let cancelled = false;
    void loadLoans(environmentId).then((loans) => {
      if (!cancelled) applyLoans(loans);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const run = async (change: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await change();
      setAccepting(null);
      setEnding(null);
      await reload();
    } catch (cause) {
      setError(errorMessageOf(cause, "That change did not go through."));
    } finally {
      setPending(false);
    }
  };
  /** Accepting a machine asks for a strong factor: the account says which one. */
  const openAccept = async (grant: Grant) => {
    setPending(true);
    setError(null);
    try {
      const account = await fetchAccount();
      setAccepting({ grant, account, stepUp: emptyStepUp(account) });
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not read your account."));
    } finally {
      setPending(false);
    }
  };
  const settle = async <A,>(result: Promise<AtomCommandResult<A, unknown>>) => {
    const done = await result;
    if (done._tag !== "Success") throw squashAtomCommandFailure(done);
  };

  const waiting = (received ?? []).filter((grant) => grant.state === "pending" && grant.can.decide);
  const borrowed = (received ?? []).filter((grant) => grant.state === "active");
  if (given === null && received === null && error === null) return null;
  if ((given ?? []).length === 0 && (received ?? []).length === 0 && error === null) return null;

  return (
    <SettingsSection id="grants" title="Loans">
      {waiting.map((grant) => (
        <SettingsRow
          key={grant.id}
          title={`${grant.resource.name ?? "A machine"} for ${grant.target?.name ?? "your Space"}`}
          description={
            <>
              {`Waiting for you: lent by ${grant.lender.name ?? "another User"} · ${limitsText(grant.limits)}`}
              <br />
              <span className="text-warning">
                {lenderSeesEverything(grant.lender.name ?? "Its lender")}
              </span>
            </>
          }
          control={
            mayChange ? (
              <div className="flex gap-1">
                <Button disabled={pending} size="xs" onClick={() => void openAccept(grant)}>
                  Accept…
                </Button>
                <Button
                  disabled={pending}
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void run(() =>
                      settle(commands.reject({ environmentId, input: { grantId: grant.id } })),
                    )
                  }
                >
                  Reject
                </Button>
              </div>
            ) : null
          }
        />
      ))}
      {borrowed.map((grant) => (
        <SettingsRow
          key={grant.id}
          title={`${grant.resource.name ?? "A machine"} in ${grant.target?.name ?? "your Space"}`}
          description={
            <>
              {loanDescription(grant, "received")}
              <br />
              <span className="text-muted-foreground">
                {lenderSeesEverything(grant.lender.name ?? "Its lender")}
              </span>
            </>
          }
          control={
            mayChange && grant.can.return ? (
              <Button
                disabled={pending}
                size="xs"
                variant="outline"
                onClick={() => setEnding(grant)}
              >
                Give back
              </Button>
            ) : null
          }
        />
      ))}
      {(given ?? []).map((grant) => (
        <SettingsRow
          key={grant.id}
          title={`${grant.resource.name ?? "Your machine"}`}
          description={loanDescription(grant, "given")}
          control={
            mayChange && (grant.can.revoke || grant.can.cancel) ? (
              <Button
                disabled={pending}
                size="xs"
                variant="destructive-outline"
                onClick={() =>
                  grant.can.cancel
                    ? void run(() =>
                        settle(commands.cancel({ environmentId, input: { grantId: grant.id } })),
                      )
                    : setEnding(grant)
                }
              >
                {grant.can.cancel ? "Cancel" : "Take back"}
              </Button>
            ) : null
          }
        />
      ))}
      {error === null ? null : <SettingsRow title="Something went wrong" description={error} />}
      {accepting !== null ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setAccepting(null))}>
          <DialogPopup className="sm:max-w-md">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  acceptGrant(accepting.grant.id, toStepUp(accepting.account, accepting.stepUp)),
                );
              }}
            >
              <DialogHeader>
                <DialogTitle>Accept {accepting.grant.resource.name ?? "this machine"}?</DialogTitle>
                <DialogDescription>
                  {lenderSeesEverything(accepting.grant.lender.name ?? "Its lender")} Only accept
                  machines of people you trust that much.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    {limitsText(accepting.grant.limits)}
                  </p>
                  {accepting.grant.machine?.host == null ? null : (
                    <HostState host={accepting.grant.machine.host} />
                  )}
                  <StepUpFields
                    account={accepting.account}
                    disabled={pending}
                    value={accepting.stepUp}
                    onChange={(stepUp) => setAccepting({ ...accepting, stepUp })}
                  />
                </div>
              </DialogPanel>
              <DialogFooter>
                <Button
                  disabled={pending}
                  type="button"
                  variant="ghost"
                  onClick={() => setAccepting(null)}
                >
                  Cancel
                </Button>
                <Button disabled={pending} type="submit">
                  Confirm and accept
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
      {ending !== null ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setEnding(null))}>
          <DialogPopup className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {ending.can.revoke ? "Take back" : "Give back"}{" "}
                {ending.resource.name ?? "this machine"}?
              </DialogTitle>
              <DialogDescription>
                {`The Threads of ${ending.target?.name ?? "the Space"} on it stop: running turns get up to two minutes to save a checkpoint, and changes made by hand since the last turn may be lost. Its Sandbox and files are then deleted from the machine.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button disabled={pending} variant="ghost" onClick={() => setEnding(null)}>
                Keep it
              </Button>
              <Button
                disabled={pending}
                variant="destructive"
                onClick={() =>
                  void run(() =>
                    settle(commands.end({ environmentId, input: { grantId: ending.id } })),
                  )
                }
              >
                {ending.can.revoke ? "Take back" : "Give back"}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </SettingsSection>
  );
}

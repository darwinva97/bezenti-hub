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
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useEffectEvent, useState } from "react";

import { acceptGrant, giveGrant } from "../../environments/primary/grants";
import { fetchAccount } from "../../environments/primary/userAccounts";
import { readHubLinkOrigin } from "../../hubLinks";
import { errorMessageOf } from "../../lib/errorMessage";
import { loadSpaces } from "../../state/currentSpace";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { emptyStepUp, lacksStrongFactor, StepUpFields, toStepUp } from "./AccountSettingsSection";
import {
  endingWarning,
  groupLenderSays,
  groupLentLoans,
  hostLimitsNotice,
  lenderSees,
  lenderSeesEverything,
  lentCountText,
  limitsText,
  loanDescription,
  loanStatusParts,
  nounOf,
  offerLinkOf,
  offerStatusText,
  receivedSections,
  recipientLabel,
  spaceLabel,
  stateText,
  targetLabel,
} from "@t3tools/client-runtime/grants-view";
import { ChangeCapsDialog } from "./LendAiAccountDialog";
import { LoanUsage } from "./LoanUsage";
import { BY_LINK, BY_LINK_LABEL, OfferLinkField } from "./OfferLinkField";
import { StrongFactorNotice } from "./StrongFactorNotice";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { VaultLoanUsage } from "./VaultLoanUsage";

const GIB = 1024 ** 3;

/** What the lender accepts by lending. */
const LENDER_RISKS = [
  "All the Sandboxes on this machine run as your Linux user: someone who breaks out of one has your account here, and can reach the other Sandboxes.",
  "Their traffic leaves from this machine's address and can reach your network.",
  "Disk is measured every minute, not capped: a Sandbox can go over its limit between two checks.",
];

/** Where the lender replaces a lent group's Secrets: their own Vault, or their Organization's. */
const vaultSettingsOf = (grant: Grant) =>
  grant.lender.kind === "user"
    ? ({ to: "/settings/user/$section", params: { section: "vault" } } as const)
    : ({
        to: "/settings/space/$spaceId/$section",
        params: { spaceId: grant.lender.id, section: "vault" },
      } as const);

/**
 * Grants ticket 07: the Secrets of a lent group its borrower's agents could read, to rotate: all of
 * them before taking it back, those not replaced since once it ended. Names only.
 */
function RotateList({
  grant,
  onReplace,
}: {
  readonly grant: Grant;
  readonly onReplace: () => void;
}) {
  const toRotate = grant.vaultGroup?.toRotate ?? [];
  if (toRotate.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-xs" role="note">
      <p className="text-warning">Values may have been read. Rotate these Secrets:</p>
      <ul className="flex flex-wrap items-center gap-2" aria-label="Secrets to rotate">
        {toRotate.map((entry) => (
          <li key={entry.entryId}>
            <code className="font-mono">{entry.name}</code>
          </li>
        ))}
        <li>
          <Button size="xs" type="button" variant="outline" onClick={onReplace}>
            Replace…
          </Button>
        </li>
      </ul>
    </div>
  );
}

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
  const notEnforced = hostLimitsNotice(host);
  return (
    <div className="flex flex-col gap-1 text-xs">
      {host.ready ? null : (
        <p className="text-destructive" role="alert">
          This machine cannot run a Sandbox for another Space now: {host.reason} Run{" "}
          <code>t3 sandbox doctor</code> on this machine to see how to fix it.
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
  const navigate = useNavigate();
  const targetsCommand = useAtomCommand(grantsEnvironment.targets, "list where you may lend");
  const givenCommand = useAtomCommand(grantsEnvironment.listGiven, "list your loans");
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
  // Grants ticket 15: a lending link for a Space not in the list, shown once.
  const createOffer = useAtomCommand(grantsEnvironment.createOffer, "make a lending link");
  const [link, setLink] = useState<string | null>(null);

  const loadTargets = useEffectEvent((target: EnvironmentId) =>
    Promise.all([
      targetsCommand({
        environmentId: target,
        input: { resource: { kind: "environment", environmentId: machine.id } },
      }),
      givenCommand({ environmentId: target, input: {} }),
    ]),
  );
  const applyTargets = useEffectEvent(([found, given]: Awaited<ReturnType<typeof loadTargets>>) => {
    if (found._tag === "Success") {
      // A Space with a pending or active loan of this machine cannot get a second one: leave it out.
      const lentTo = new Set(
        given._tag === "Success"
          ? given.value.grants
              .filter(
                (grant) =>
                  grant.resource.kind === "environment" &&
                  grant.resource.id === machine.id &&
                  (grant.state === "pending" || grant.state === "active"),
              )
              .map((grant) => grant.target?.spaceId)
          : [],
      );
      setTargets(found.value.targets.filter((entry) => !lentTo.has(entry.spaceId)));
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
  const byLink = spaceId === BY_LINK;
  const limits: EnvironmentGrantLimits = {
    kind: "environment",
    cpus: Number(cpus),
    memoryBytes: Math.round(Number(memory) * GIB),
    pids: Math.round(Number(pids)),
    diskBytes: Math.round(Number(disk) * GIB),
  };
  const valid =
    (target !== undefined || byLink) &&
    [limits.cpus, limits.memoryBytes, limits.pids, limits.diskBytes].every(
      (value) => Number.isFinite(value) && value > 0,
    );

  const submit = async () => {
    if (byLink) {
      if (environmentId === null) return;
      setPending(true);
      setError(null);
      try {
        const made = await createOffer({
          environmentId,
          input: { resource: { kind: "environment", environmentId: machine.id }, limits },
        });
        if (made._tag !== "Success") throw squashAtomCommandFailure(made);
        setLink(offerLinkOf(made.value, readHubLinkOrigin() ?? window.location.origin));
      } catch (cause) {
        setError(errorMessageOf(cause, "The link was not made."));
      } finally {
        setPending(false);
      }
      return;
    }
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
          className="flex min-h-0 flex-col"
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
                <Select
                  value={spaceId}
                  disabled={link !== null}
                  onValueChange={(next) => setSpaceId(String(next ?? ""))}
                >
                  <SelectTrigger aria-label="Lend to">
                    <SelectValue>
                      {byLink
                        ? BY_LINK_LABEL
                        : target
                          ? spaceLabel(target)
                          : targets === null
                            ? "Loading…"
                            : "Choose a Space"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(targets ?? []).map((entry) => (
                      <SelectItem key={entry.spaceId} value={entry.spaceId}>
                        {spaceLabel(entry)}
                      </SelectItem>
                    ))}
                    {targets === null ? null : (
                      <SelectItem value={BY_LINK}>{BY_LINK_LABEL}</SelectItem>
                    )}
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
              {byLink && link === null ? (
                <p className="text-xs text-muted-foreground">
                  Whoever opens the link chooses one of their Spaces where they decide on loans;
                  applying it there starts the loan at once, after they confirm it's them. It works
                  once, for 7 days; you can cancel it in Loans until then.
                </p>
              ) : null}
              {link === null ? null : (
                <>
                  <OfferLinkField
                    link={link}
                    onCopyFailed={() => setError("Could not copy: select the link and copy it.")}
                  />
                  <p className="text-xs" role="status">
                    Link made. Copy it now: it is not shown again.
                  </p>
                </>
              )}
              {account !== null && stepUp !== null && lacksStrongFactor(account) ? (
                <StrongFactorNotice
                  onOpenAccount={() => {
                    onClose();
                    void navigate({
                      to: "/settings/user/$section",
                      params: { section: "account" },
                    });
                  }}
                />
              ) : null}
              {account !== null && stepUp !== null && !lacksStrongFactor(account) ? (
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
              {link === null ? "Cancel" : "Close"}
            </Button>
            {link === null ? (
              <Button
                disabled={
                  pending ||
                  !valid ||
                  host?.ready === false ||
                  (target?.startsActive === true && account !== null && lacksStrongFactor(account))
                }
                type="submit"
              >
                {byLink
                  ? "Make link"
                  : target?.startsActive === true && account !== null
                    ? "Confirm and lend"
                    : "Lend"}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Groups start open while the User has few loans, closed when there are many. */
const OPEN_GROUPS_UP_TO = 6;

function LoanGroupTitle({ children }: { readonly children: string }) {
  return (
    <h3 className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground sm:px-4">{children}</h3>
  );
}

/**
 * Settings → Environments → «Loans»: machines, AI accounts and Vault groups the User (or an
 * Organization they run) lent (take back, cancel; a group's Secrets to rotate), loans waiting for a
 * Space they decide for (accept, a machine with a strong factor; reject) and what their Spaces
 * borrow (give back). Never another Space's Threads.
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
  // Right after a page load or a Hub restart the session is not up yet: wait for it, then load.
  const connected = useEnvironment(environmentId)?.connection.phase === "connected";
  const navigate = useNavigate();
  const [accepting, setAccepting] = useState<{
    readonly grant: Grant;
    readonly account: AuthAccount;
    readonly stepUp: StepUpState;
  } | null>(null);
  const [ending, setEnding] = useState<Grant | null>(null);
  // Grants ticket 07: a Vault group's loan, accepted with or without becoming a default.
  const [acceptingGroup, setAcceptingGroup] = useState<{
    readonly grant: Grant;
    readonly useAsDefault: boolean;
  } | null>(null);
  const [capping, setCapping] = useState<Grant | null>(null);
  // Grants ticket 04: one AI account loan's use, opened from its row.
  const [usageOf, setUsageOf] = useState<string | null>(null);
  // Groups the User opened or closed by hand, by resource; the rest follow the default.
  const [groupToggles, setGroupToggles] = useState<Readonly<Record<string, boolean>>>({});
  // Grants ticket 15: a borrowed Vault group's use, for whoever runs the Space (its Admins).
  const loanUseButton = (grant: Grant) =>
    grant.resource.kind === "ai-account" ||
    (grant.resource.kind === "vault-group" && grant.can.return) ? (
      <Button
        size="xs"
        variant="ghost"
        aria-expanded={usageOf === grant.id}
        onClick={() => setUsageOf(usageOf === grant.id ? null : grant.id)}
      >
        Use
      </Button>
    ) : null;
  const usagePanel = (grant: Grant) =>
    usageOf === grant.id ? (
      <div className="px-4 pb-3 sm:pl-10">
        {grant.resource.kind === "vault-group" ? (
          <VaultLoanUsage environmentId={environmentId} grant={grant} />
        ) : (
          <LoanUsage environmentId={environmentId} grant={grant} />
        )}
      </div>
    ) : null;

  const fetchLoans = (target: EnvironmentId) =>
    Promise.all([
      commands.listGiven({ environmentId: target, input: {} }),
      commands.listReceived({ environmentId: target, input: {} }),
    ]);
  const showLoans = ([mine, ours]: Awaited<ReturnType<typeof fetchLoans>>) => {
    if (mine._tag === "Success") setGiven(mine.value.grants);
    if (ours._tag === "Success") setReceived(ours.value.grants);
    const failed = mine._tag === "Success" ? ours : mine;
    if (failed._tag === "Success") {
      setError(null);
      return;
    }
    const cause = squashAtomCommandFailure(failed);
    // A session that is not up yet is not an error to show: the load runs again once it is.
    setError(
      (cause as { readonly _tag?: string } | null)?._tag === "EnvironmentRpcUnavailableError"
        ? null
        : errorMessageOf(cause, "Could not read the loans."),
    );
  };
  const loadLoans = useEffectEvent(fetchLoans);
  const applyLoans = useEffectEvent(showLoans);
  const reload = async () => showLoans(await fetchLoans(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the User's loans from the Hub when the section opens.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void loadLoans(environmentId).then((loans) => {
      if (!cancelled) applyLoans(loans);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, connected]);

  const run = async (change: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await change();
      setAccepting(null);
      setAcceptingGroup(null);
      setEnding(null);
      await reload();
      // Grants ticket 12: the Space selector's count of loans waiting follows the decision.
      void loadSpaces(environmentId);
    } catch (cause) {
      setError(errorMessageOf(cause, "That change did not go through."));
    } finally {
      setPending(false);
    }
  };
  /** Accepting a machine asks for a strong factor (the account says which one); an AI account not. */
  const openAccept = async (grant: Grant) => {
    if (grant.resource.kind === "vault-group") {
      setAcceptingGroup({ grant, useAsDefault: true });
      return;
    }
    if (grant.resource.kind !== "environment") {
      await run(() => acceptGrant(grant.id, undefined));
      return;
    }
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

  // Waiting for a decision, in use, and ended (Grants ticket 11: by whom or by itself, and when).
  const { waiting, borrowed, ended: endedHere } = receivedSections(received ?? []);
  if (given === null && received === null && error === null) return null;
  if ((given ?? []).length === 0 && (received ?? []).length === 0 && error === null) return null;

  const lentGroups = groupLentLoans(given ?? []);
  const lentCount = (given ?? []).length;

  /** The «⋯» menu of one loan lent by the User: what they may do with it, as before. */
  const lentActions = (grant: Grant, label: string) => {
    // A link nobody applied has no use to view.
    const isAi = grant.resource.kind === "ai-account" && grant.target !== null;
    const hasUse = isAi || (grant.resource.kind === "vault-group" && grant.target !== null);
    const mayCap = mayChange && isAi && grant.can.setLimits;
    const mayEnd = mayChange && (grant.can.revoke || grant.can.cancel);
    if (!hasUse && !mayEnd) return null;
    return (
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={`Actions for ${label}`}
              size="icon-xs"
              type="button"
              variant="ghost"
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={6}>
          {hasUse ? (
            <MenuItem onClick={() => setUsageOf(usageOf === grant.id ? null : grant.id)}>
              View use
            </MenuItem>
          ) : null}
          {mayCap ? (
            <MenuItem disabled={pending} onClick={() => setCapping(grant)}>
              Caps…
            </MenuItem>
          ) : null}
          {mayEnd ? (
            <MenuItem
              disabled={pending}
              variant="destructive"
              onClick={() =>
                grant.can.cancel
                  ? void run(() =>
                      settle(commands.cancel({ environmentId, input: { grantId: grant.id } })),
                    )
                  : setEnding(grant)
              }
            >
              {grant.can.cancel ? "Cancel" : "Take back"}
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    );
  };

  return (
    <SettingsSection id="grants" title="Loans">
      {waiting.length === 0 ? null : <LoanGroupTitle>Waiting for you</LoanGroupTitle>}
      {waiting.map((grant) => (
        <SettingsRow
          key={grant.id}
          title={`${grant.resource.name ?? `A ${nounOf(grant)}`} for ${targetLabel(grant, "your Space")}`}
          description={
            <>
              {`Waiting for you: lent by ${grant.lender.name ?? "another User"} · ${limitsText(grant.limits)}`}
              <br />
              <span className="text-warning">{lenderSees(grant)}</span>
            </>
          }
          control={
            mayChange ? (
              <div className="flex gap-1">
                <Button disabled={pending} size="xs" onClick={() => void openAccept(grant)}>
                  {grant.resource.kind === "ai-account" ? "Accept" : "Accept…"}
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
      {borrowed.length === 0 ? null : <LoanGroupTitle>Borrowed by your Spaces</LoanGroupTitle>}
      {borrowed.map((grant) => (
        <Fragment key={grant.id}>
          <SettingsRow
            title={`${grant.resource.name ?? `A ${nounOf(grant)}`} in ${targetLabel(grant, "your Space")}`}
            description={
              <>
                {loanDescription(grant, "received")}
                <br />
                <span className="text-muted-foreground">{lenderSees(grant)}</span>
              </>
            }
            control={
              <div className="flex gap-1">
                {loanUseButton(grant)}
                {mayChange && grant.can.return ? (
                  <Button
                    disabled={pending}
                    size="xs"
                    variant="outline"
                    onClick={() => setEnding(grant)}
                  >
                    Give back
                  </Button>
                ) : null}
              </div>
            }
          />
          {usagePanel(grant)}
        </Fragment>
      ))}
      {endedHere.length === 0 ? null : <LoanGroupTitle>Ended loans to your Spaces</LoanGroupTitle>}
      {endedHere.map((grant) => (
        <SettingsRow
          key={grant.id}
          title={`${grant.resource.name ?? `A ${nounOf(grant)}`} in ${targetLabel(grant, "your Space")}`}
          description={loanDescription(grant, "received")}
        />
      ))}
      {lentGroups.length === 0 ? null : <LoanGroupTitle>Lent by you</LoanGroupTitle>}
      {lentGroups.map((group) => {
        const open = groupToggles[group.key] ?? lentCount <= OPEN_GROUPS_UP_TO;
        const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
        return (
          <div key={group.key} className="border-t border-border/60 first:border-t-0">
            <button
              aria-expanded={open}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
              type="button"
              onClick={() => setGroupToggles({ ...groupToggles, [group.key]: !open })}
            >
              <Chevron aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.name}</span>{" "}
              <span className="shrink-0 text-xs text-muted-foreground">{lentCountText(group)}</span>
            </button>
            {open ? (
              <ul aria-label={`${group.name} is lent to`} className="pb-1">
                {group.loans.map((grant) => {
                  const recipient = recipientLabel(grant);
                  // A link nobody applied says why it works or not; an applied one is a loan.
                  const unapplied =
                    grant.offer !== undefined && grant.offer.status !== "used" ? grant.offer : null;
                  const detail = [
                    unapplied !== null
                      ? offerStatusText(unapplied)
                      : grant.state === "active"
                        ? null
                        : stateText(grant),
                    limitsText(grant.limits),
                    ...loanStatusParts(grant),
                  ]
                    .filter((part) => part !== null)
                    .join(" · ");
                  return (
                    <li key={grant.id}>
                      <div className="flex items-start gap-2 py-1 pr-2 pl-9 sm:pr-3 sm:pl-10">
                        <div className="min-w-0 flex-1">
                          <p className="min-w-0 truncate text-sm">{recipient}</p>
                          <p className="text-xs break-words text-muted-foreground">{detail}</p>
                          {grant.state === "ended" ? (
                            <RotateList
                              grant={grant}
                              onReplace={() => void navigate(vaultSettingsOf(grant))}
                            />
                          ) : null}
                        </div>
                        {lentActions(grant, `${group.name} lent to ${recipient}`)}
                      </div>
                      {usagePanel(grant)}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
      {error === null ? null : (
        <SettingsRow
          title="Something went wrong"
          description={error}
          control={
            <Button size="xs" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          }
        />
      )}
      {capping !== null ? (
        <ChangeCapsDialog
          environmentId={environmentId}
          grant={capping}
          onClose={() => setCapping(null)}
          onChanged={reload}
        />
      ) : null}
      {accepting !== null ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setAccepting(null))}>
          <DialogPopup className="sm:max-w-md">
            <form
              className="flex min-h-0 flex-col"
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
                  {lacksStrongFactor(accepting.account) ? (
                    <StrongFactorNotice
                      onOpenAccount={() => {
                        setAccepting(null);
                        void navigate({
                          to: "/settings/user/$section",
                          params: { section: "account" },
                        });
                      }}
                    />
                  ) : null}
                  {lacksStrongFactor(accepting.account) ? null : (
                    <StepUpFields
                      account={accepting.account}
                      disabled={pending}
                      value={accepting.stepUp}
                      onChange={(stepUp) => setAccepting({ ...accepting, stepUp })}
                    />
                  )}
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
                <Button disabled={pending || lacksStrongFactor(accepting.account)} type="submit">
                  Confirm and accept
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
      {acceptingGroup !== null ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setAcceptingGroup(null))}>
          <DialogPopup className="sm:max-w-md">
            <form
              className="flex min-h-0 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  acceptGrant(acceptingGroup.grant.id, undefined, {
                    useAsDefault: acceptingGroup.useAsDefault,
                  }),
                );
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  Accept {acceptingGroup.grant.resource.name ?? "this Vault group"}?
                </DialogTitle>
                <DialogDescription>
                  {groupLenderSays(acceptingGroup.grant.lender.name ?? "Its lender")} Your Space
                  sees its Variables and the names of its Secrets, never a Secret's value.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    aria-label="Also use it as a Space default"
                    checked={acceptingGroup.useAsDefault}
                    disabled={pending}
                    onCheckedChange={(checked) =>
                      setAcceptingGroup({ ...acceptingGroup, useAsDefault: checked === true })
                    }
                  />
                  Also use it as a default of {targetLabel(acceptingGroup.grant, "this Space")}:
                  every Thread there receives it, after the Space's own defaults
                </label>
              </DialogPanel>
              <DialogFooter>
                <Button
                  disabled={pending}
                  type="button"
                  variant="ghost"
                  onClick={() => setAcceptingGroup(null)}
                >
                  Cancel
                </Button>
                <Button disabled={pending} type="submit">
                  Accept
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
                {ending.resource.name ?? `this ${nounOf(ending)}`}?
              </DialogTitle>
              <DialogDescription>{endingWarning(ending)}</DialogDescription>
            </DialogHeader>
            {ending.resource.kind === "vault-group" && ending.can.revoke ? (
              <DialogPanel>
                <RotateList
                  grant={ending}
                  onReplace={() => {
                    setEnding(null);
                    void navigate(vaultSettingsOf(ending));
                  }}
                />
              </DialogPanel>
            ) : null}
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

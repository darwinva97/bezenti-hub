import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AuthAccount,
  EnvironmentId,
  GrantTarget,
  SpaceId,
  VaultGroupId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { giveGrant } from "../../environments/primary/grants";
import { fetchAccount, type StepUp } from "../../environments/primary/userAccounts";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { confirmWithKeycloak, takeKeycloakStepUp } from "../auth/keycloakStepUp";
import { emptyStepUp, lacksStrongFactor, toStepUp } from "./AccountSettingsSection";
import { StrongFactorFields } from "./StrongFactorFields";
import { spaceLabel, vaultLendWarning } from "@t3tools/client-runtime/grants-view";

type StepUpState = ReturnType<typeof emptyStepUp>;

/**
 * «Lend…» on a named Vault group the User manages (Grants ticket 07): the Space among those they
 * may lend to, the warning that its agents read the Secrets, and always a strong factor. The Space
 * chooses it as a default or per Project; a loan the lender also decides on may be one at once.
 */
export function LendVaultGroupDialog({
  group,
  initialSpaceId,
  onClose,
  onLent,
}: {
  readonly group: { readonly id: VaultGroupId; readonly name: string };
  /** A Space to start with (the Owner's review of migrated loans). */
  readonly initialSpaceId?: SpaceId;
  readonly onClose: () => void;
  readonly onLent?: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  // Back from «Confirm with Keycloak»: the form as it was left, lent once with the proof.
  const [resume] = useState(() => {
    const back = takeKeycloakStepUp("lend-vault-group");
    return back?.pending.group.id === group.id ? back : null;
  });
  const resumed = useRef(false);
  const targetsCommand = useAtomCommand(grantsEnvironment.targets, "list where you may lend");
  const [targets, setTargets] = useState<ReadonlyArray<GrantTarget> | null>(null);
  const [spaceId, setSpaceId] = useState<string>(resume?.pending.spaceId ?? initialSpaceId ?? "");
  const [useAsDefault, setUseAsDefault] = useState(resume?.pending.useAsDefault ?? true);
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [stepUp, setStepUp] = useState<StepUpState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(
    resume !== null && "failure" in resume ? resume.failure : null,
  );
  const [done, setDone] = useState<string | null>(null);

  const lend = async (into: GrantTarget, proof: StepUp) => {
    setPending(true);
    setError(null);
    try {
      const grant = await giveGrant(
        {
          resource: { kind: "vault-group", vaultGroupId: group.id },
          spaceId: into.spaceId,
          limits: { kind: "vault-group" },
          ...(into.startsActive ? { useAsDefault } : {}),
        },
        proof,
      );
      setDone(
        grant.state === "active"
          ? `Lent to ${spaceLabel(into)}.`
          : `Waiting for ${spaceLabel(into)} to accept it.`,
      );
      onLent?.();
    } catch (cause) {
      setError(errorMessageOf(cause, "The loan did not go through."));
    } finally {
      setPending(false);
    }
  };

  const loadTargets = useEffectEvent((target: EnvironmentId) =>
    targetsCommand({
      environmentId: target,
      input: { resource: { kind: "vault-group", vaultGroupId: group.id } },
    }),
  );
  const applyTargets = useEffectEvent((found: Awaited<ReturnType<typeof targetsCommand>>) => {
    if (found._tag !== "Success") {
      setError(errorMessageOf(squashAtomCommandFailure(found), "Could not list the Spaces."));
      return;
    }
    setTargets(found.value.targets);
    if (resume !== null && "proofId" in resume && !resumed.current) {
      resumed.current = true;
      const into = found.value.targets.find((entry) => entry.spaceId === resume.pending.spaceId);
      const proof = { method: "keycloak", proofId: resume.proofId } as const;
      if (into !== undefined) void lend(into, proof);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads where the group may be lent when the dialog opens.
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
    if (account === null || stepUp === null) {
      // Lending a group always needs a strong factor: its Secrets reach another Space's agents.
      setPending(true);
      setError(null);
      try {
        const read = await fetchAccount();
        setAccount(read);
        setStepUp(emptyStepUp(read));
      } catch (cause) {
        setError(errorMessageOf(cause, "Could not read your account."));
      } finally {
        setPending(false);
      }
      return;
    }
    if (!stepUp.viaKeycloak) return lend(target, toStepUp(account, stepUp));
    setPending(true);
    setError(null);
    await confirmWithKeycloak({
      kind: "lend-vault-group",
      group,
      spaceId: target.spaceId,
      useAsDefault,
      fromReview: initialSpaceId !== undefined,
    }).catch((cause: unknown) => {
      setError(errorMessageOf(cause, "Could not start confirming with Keycloak."));
      setPending(false);
    });
  };

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
            <DialogTitle>Lend {group.name}</DialogTitle>
            <DialogDescription>
              The Space sees its Variables and the names of its Secrets, never a Secret's value, and
              chooses it as a default or per Project. Your changes reach its next turn. You can take
              it back at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Lend to
                <Select
                  value={spaceId}
                  disabled={done !== null || account !== null}
                  onValueChange={(next) => setSpaceId(String(next ?? ""))}
                >
                  <SelectTrigger aria-label="Lend to">
                    <SelectValue>
                      {target
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
                  </SelectPopup>
                </Select>
              </label>
              <p className="text-xs text-warning" role="note">
                {vaultLendWarning(target === undefined ? "the Space" : spaceLabel(target))}
              </p>
              {target === undefined ? null : target.startsActive ? (
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    aria-label="Also use it as a Space default"
                    checked={useAsDefault}
                    disabled={pending || done !== null}
                    onCheckedChange={(checked) => setUseAsDefault(checked === true)}
                  />
                  You also decide for this Space: it is lent at once. Also use it as a Space default
                </label>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The loan waits until this Space accepts it.
                </p>
              )}
              {account !== null && stepUp !== null ? (
                <StrongFactorFields
                  account={account}
                  action="lend a Vault group"
                  disabled={pending || done !== null}
                  value={stepUp}
                  onChange={setStepUp}
                  onOpenAccount={() => {
                    onClose();
                    void navigate({
                      to: "/settings/user/$section",
                      params: { section: "account" },
                    });
                  }}
                />
              ) : null}
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
                disabled={
                  pending ||
                  target === undefined ||
                  (account !== null && lacksStrongFactor(account))
                }
                type="submit"
              >
                {account === null
                  ? "Lend…"
                  : stepUp?.viaKeycloak === true
                    ? "Confirm with Keycloak"
                    : "Confirm and lend"}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

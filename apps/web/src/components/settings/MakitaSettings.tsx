import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MakitaAccountGetResult,
  type MakitaAccountView,
  type MakitaAccountWarning,
  type MakitaPermission,
  type MakitaPermissionCandidate,
  type MakitaPermissionsListResult,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { makitaEnvironment } from "../../state/makita";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
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
import { InfoTip } from "./InfoTip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type AccountAnswer = AtomCommandResult<MakitaAccountGetResult, unknown>;

const formatWhen = (iso: string | null) =>
  iso === null
    ? "Never"
    : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const WARNINGS: Readonly<Record<MakitaAccountWarning, string>> = {
  "token-invalid":
    "GitHub refuses this token: Makita cannot read or write anything. Replace the token.",
  expired: "This token has expired. Make a new one on the bot's account and replace it here.",
  "expires-soon": "This token expires in less than 14 days. Replace it before then.",
  "no-repo-scope":
    "This classic token has neither public_repo nor repo: Makita cannot write to any repository.",
  "rate-limited": "GitHub's rate limit for this token was spent at the last check.",
  unreachable: "GitHub could not be reached at the last check.",
};

const STATUS_LABEL: Readonly<Record<MakitaAccountView["status"], string>> = {
  ok: "Working",
  "token-invalid": "Token refused",
  "rate-limited": "Rate limited",
  unreachable: "Unreachable",
};

function useMakitaAccountCommands() {
  return {
    get: useAtomCommand(makitaEnvironment.getAccount, "read Makita's account"),
    set: useAtomCommand(makitaEnvironment.setAccount, "save Makita's token"),
    pauseAll: useAtomCommand(makitaEnvironment.pauseAll, "stop all Makita work"),
    resumeAll: useAtomCommand(makitaEnvironment.resumeAll, "resume Makita"),
  };
}

/**
 * Platform → Makita: the bot's GitHub account, «Stop all Makita work» and who may use Makita
 * (the Owner's).
 */
export function PlatformMakitaSection() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : (
        <>
          <MakitaAccountPanel environmentId={environmentId} />
          <MakitaPermissionsPanel environmentId={environmentId} />
        </>
      )}
    </SettingsPageContainer>
  );
}

type PermissionsAnswer = AtomCommandResult<MakitaPermissionsListResult, unknown>;

const PERMISSION_STATES: Readonly<Record<MakitaPermission["state"], string | null>> = {
  ok: null,
  "not-a-member": "No effect: no longer in this Space",
  guest: "No effect: a Guest there now",
  "user-inactive": "No effect: the User is disabled",
  "space-archived": "No effect while the Space is archived",
  "space-frozen": "No effect: the Space is closed",
  "space-gone": "No effect: the Space no longer exists",
};

const ROLE_LABEL: Readonly<Record<NonNullable<MakitaPermission["role"]>, string>> = {
  admin: "Admin",
  member: "Member",
  guest: "Guest",
  personal: "Personal space",
};

/** «Who may use Makita»: the Owner's grants per User and Space, given and taken back here. */
function MakitaPermissionsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const list = useAtomCommand(makitaEnvironment.listPermissions, "read who may use Makita");
  const grant = useAtomCommand(makitaEnvironment.grantPermission, "allow someone to use Makita");
  const revoke = useAtomCommand(makitaEnvironment.revokePermission, "take back Makita");
  const [listed, setListed] = useState<MakitaPermissionsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<MakitaPermission | null>(null);
  const [pending, setPending] = useState(false);

  const show = (result: PermissionsAnswer, fallback: string) => {
    if (result._tag === "Success") {
      setListed(result.value);
      setError(null);
      return true;
    }
    setError(errorMessageOf(squashAtomCommandFailure(result), fallback));
    return false;
  };
  const applyFirst = useEffectEvent((result: PermissionsAnswer) =>
    show(result, "Could not read who may use Makita."),
  );
  const loadFirst = useEffectEvent((target: EnvironmentId) =>
    list({ environmentId: target, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads who may use Makita from the Hub when the section opens.
  useEffect(() => {
    let cancelled = false;
    void loadFirst(environmentId).then((result) => {
      if (!cancelled) applyFirst(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const takeBack = async (permission: MakitaPermission) => {
    setPending(true);
    show(
      await revoke({
        environmentId,
        input: { userId: permission.userId, spaceId: permission.spaceId },
      }),
      "Could not revoke it.",
    );
    setPending(false);
    setRevoking(null);
  };

  return (
    <SettingsSection
      id="makita-permissions"
      title="Who may use Makita"
      titleAction={
        <InfoTip label="About who may use Makita">
          Whoever you allow in a Space makes Makita configurations there: which repositories it
          listens to, whom it answers and which of their AI accounts it spends. Only Admins and
          Members of an Organization, or a User in their own Personal space. You may use Makita
          everywhere.
        </InfoTip>
      }
      headerAction={
        listed === null || listed.candidates.length === 0 ? null : (
          <Button size="xs" onClick={() => setGranting(true)}>
            Grant…
          </Button>
        )
      }
    >
      {error === null ? null : (
        <p className="px-4 py-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {listed === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      ) : listed.permissions.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Nobody but you yet.</p>
      ) : (
        <ul aria-label="Who may use Makita" className="divide-y divide-border/50">
          {listed.permissions.map((permission) => {
            const why = PERMISSION_STATES[permission.state];
            const label = `${permission.userName ?? permission.userId} in ${permission.spaceName ?? permission.spaceId}`;
            return (
              <li
                key={`${permission.userId} ${permission.spaceId}`}
                aria-label={label}
                className="flex flex-col gap-2 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-4 sm:px-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate font-medium">
                      {permission.userName ?? permission.userId}
                    </span>
                    <span className="text-muted-foreground">in</span>
                    <span className="truncate">
                      {permission.spaceName ?? "A Space that no longer exists"}
                    </span>
                    {permission.role === null ? null : (
                      <Badge variant="secondary" size="sm">
                        {ROLE_LABEL[permission.role]}
                      </Badge>
                    )}
                    {why === null ? null : (
                      <Badge variant="warning" size="sm">
                        {why}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {`Allowed by ${permission.grantedByName ?? permission.grantedBy} on ${formatWhen(permission.grantedAt)}`}
                  </span>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`Revoke ${label}`}
                  onClick={() => setRevoking(permission)}
                >
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {granting && listed !== null ? (
        <GrantDialog
          candidates={listed.candidates}
          onClose={() => setGranting(false)}
          onGrant={async (userId, spaceId) => {
            const result = await grant({ environmentId, input: { userId, spaceId } });
            if (result._tag === "Success") {
              setListed(result.value);
              setGranting(false);
              return null;
            }
            return errorMessageOf(squashAtomCommandFailure(result), "Could not grant it.");
          }}
        />
      ) : null}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRevoking(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke Makita for {revoking?.userName ?? "this User"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They can no longer make Makita configurations in {revoking?.spaceName ?? "this Space"}
              . You can grant it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={pending}
              render={<Button variant="outline" disabled={pending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending || revoking === null}
              onClick={() => {
                if (revoking !== null) void takeBack(revoking);
              }}
            >
              Revoke
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/** Choose a User, then one of the Spaces where they may receive it. */
function GrantDialog(props: {
  readonly candidates: ReadonlyArray<MakitaPermissionCandidate>;
  readonly onClose: () => void;
  readonly onGrant: (userId: UserId, spaceId: SpaceId) => Promise<string | null>;
}) {
  const [userId, setUserId] = useState<string>("");
  const [spaceId, setSpaceId] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidate = props.candidates.find((entry) => entry.userId === userId) ?? null;
  const space = candidate?.spaces.find((entry) => entry.spaceId === spaceId) ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          aria-label="Grant «may use Makita»"
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (candidate === null || space === null) return;
            setPending(true);
            setError(null);
            void props
              .onGrant(candidate.userId, space.spaceId)
              .then(setError)
              .finally(() => setPending(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Grant «may use Makita»</DialogTitle>
            <DialogDescription>
              They will make Makita configurations in that Space, spending AI accounts they may use
              there.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium">
                User
                <Select
                  value={userId}
                  disabled={pending}
                  onValueChange={(next) => {
                    setUserId(String(next ?? ""));
                    setSpaceId("");
                  }}
                >
                  <SelectTrigger aria-label="User">
                    <SelectValue>{candidate?.name ?? "Choose a User"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {props.candidates.map((entry) => (
                      <SelectItem key={entry.userId} value={entry.userId}>
                        {entry.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Space
                <Select
                  value={spaceId}
                  disabled={pending || candidate === null}
                  onValueChange={(next) => setSpaceId(String(next ?? ""))}
                >
                  <SelectTrigger aria-label="Space">
                    <SelectValue>
                      {space === null
                        ? "Choose a Space"
                        : `${space.name} (${ROLE_LABEL[space.role]})`}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(candidate?.spaces ?? []).map((entry) => (
                      <SelectItem key={entry.spaceId} value={entry.spaceId}>
                        {`${entry.name} (${ROLE_LABEL[entry.role]})`}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              {error === null ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => props.onClose()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || candidate === null || space === null}>
              Grant
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function MakitaAccountPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const commands = useMakitaAccountCommands();
  const [account, setAccount] = useState<MakitaAccountView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [switching, setSwitching] = useState(false);

  const show = (result: AccountAnswer, fallback: string) => {
    if (result._tag === "Success") {
      setAccount(result.value.account);
      setError(null);
      return true;
    }
    setError(errorMessageOf(squashAtomCommandFailure(result), fallback));
    return false;
  };
  const applyFirst = useEffectEvent((result: AccountAnswer) =>
    show(result, "Could not read Makita's account."),
  );
  const loadFirst = useEffectEvent((target: EnvironmentId) =>
    commands.get({ environmentId: target, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads Makita's account from the Hub when the section opens.
  useEffect(() => {
    let cancelled = false;
    void loadFirst(environmentId).then((result) => {
      if (!cancelled) applyFirst(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const checkNow = async () => {
    setChecking(true);
    show(
      await commands.get({ environmentId, input: { check: true } }),
      "Could not check the token.",
    );
    setChecking(false);
  };
  const setPaused = async (paused: boolean) => {
    setSwitching(true);
    const result = paused
      ? await commands.pauseAll({ environmentId, input: {} })
      : await commands.resumeAll({ environmentId, input: {} });
    show(result, paused ? "Could not stop Makita." : "Could not resume Makita.");
    setSwitching(false);
    setConfirmStop(false);
  };

  return (
    <>
      <SettingsSection
        id="makita-account"
        title="Makita's GitHub account"
        titleAction={
          <InfoTip label="About Makita's account">
            Makita is a normal GitHub account that a Hub agent works behind: it answers issues in
            the repositories its configurations listen to. Its token stays in the Hub, sealed with
            the master key; no person, machine or Thread ever reads it back.
          </InfoTip>
        }
        headerAction={
          account === undefined ? null : (
            <div className="flex items-center gap-2">
              {account === null ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={checking}
                  onClick={() => void checkNow()}
                >
                  {checking ? "Checking…" : "Check now"}
                </Button>
              )}
              <Button size="xs" onClick={() => setEditing(true)}>
                {account === null ? "Register account" : "Replace token"}
              </Button>
            </div>
          )
        }
      >
        {error === null ? null : (
          <p className="px-4 py-3 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {account === undefined ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
        ) : account === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No account yet. Create a GitHub account for the bot, make a personal access token on it,
            and register it here.
          </p>
        ) : (
          <AccountRow account={account} />
        )}
      </SettingsSection>
      {account === undefined || account === null ? null : (
        <SettingsSection
          id="makita-stop"
          title="Stop all Makita work"
          titleAction={
            <InfoTip label="About stopping Makita">
              Stops every configuration at once, also the work in progress. Only you resume it.
            </InfoTip>
          }
          headerAction={
            account.globalPausedAt === null ? (
              <Button
                size="xs"
                variant="destructive"
                disabled={switching}
                onClick={() => setConfirmStop(true)}
              >
                Stop all Makita work
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={switching}
                onClick={() => void setPaused(false)}
              >
                Resume Makita
              </Button>
            )
          }
        >
          <p className="px-4 py-3 text-sm text-muted-foreground" aria-label="Makita's state">
            {account.globalPausedAt === null
              ? "Makita may work where its configurations allow."
              : `Stopped by ${account.globalPausedByName ?? "the Owner"} on ${formatWhen(account.globalPausedAt)}. Nothing runs until you resume it.`}
          </p>
        </SettingsSection>
      )}
      {editing ? (
        <TokenDialog
          environmentId={environmentId}
          replacing={account !== null && account !== undefined}
          save={commands.set}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setAccount(saved);
            setError(null);
            setEditing(false);
          }}
        />
      ) : null}
      <AlertDialog
        open={confirmStop}
        onOpenChange={(open) => {
          if (!open && !switching) setConfirmStop(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop all Makita work?</AlertDialogTitle>
            <AlertDialogDescription>
              Every configuration stops, and so does the work in progress. Makita writes nothing on
              GitHub about it. Only you resume it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={switching}
              render={<Button variant="outline" disabled={switching} />}
            >
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={switching} onClick={() => void setPaused(true)}>
              Stop all Makita work
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** The account, dense: login and status; the token's kind, hint, scopes and expiry; warnings. */
function AccountRow({ account }: { readonly account: MakitaAccountView }) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 text-sm sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate font-medium">@{account.login}</span>
        <Badge variant={account.status === "ok" ? "success" : "error"} size="sm">
          {STATUS_LABEL[account.status]}
        </Badge>
        {account.globalPausedAt === null ? null : (
          <Badge variant="warning" size="sm">
            Stopped
          </Badge>
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        {account.tokenKind === "classic" ? "Classic token" : "Fine-grained token"}{" "}
        <span className="font-mono">…{account.hint}</span>
        {" · "}
        {account.scopes === null
          ? "Permissions set on GitHub"
          : account.scopes.length === 0
            ? "No scopes"
            : `Scopes: ${account.scopes.join(", ")}`}
        {" · "}
        {account.expiresAt === null ? "No expiry" : `Expires ${formatWhen(account.expiresAt)}`}
      </span>
      <span className="text-xs text-muted-foreground">
        Last checked {formatWhen(account.checkedAt)}
      </span>
      {account.warnings.length === 0 ? null : (
        <ul className="flex flex-col gap-1" aria-label="Warnings">
          {account.warnings.map((warning) => (
            <li key={warning} className="text-xs text-warning-foreground">
              {WARNINGS[warning]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Register or replace the token: pasted once, checked by GitHub, never shown again. */
function TokenDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly replacing: boolean;
  readonly save: ReturnType<typeof useMakitaAccountCommands>["set"];
  readonly onClose: () => void;
  readonly onSaved: (account: MakitaAccountView | null) => void;
}) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <form
          aria-label={props.replacing ? "Replace Makita's token" : "Register Makita's account"}
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setError(null);
            void props
              .save({
                environmentId: props.environmentId,
                input: { token: Redacted.make(token.trim()) },
              })
              .then((result) => {
                if (result._tag === "Success") {
                  setToken("");
                  props.onSaved(result.value.account);
                } else {
                  setError(
                    errorMessageOf(squashAtomCommandFailure(result), "Could not save the token."),
                  );
                }
              })
              .finally(() => setPending(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.replacing ? "Replace Makita's token" : "Register Makita's account"}
            </DialogTitle>
            <DialogDescription>
              Paste a personal access token made on the bot's own GitHub account. The Hub checks it
              with GitHub and keeps it sealed; it is never shown again.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Token
                <Input
                  aria-label="Token"
                  nativeInput
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  placeholder="ghp_… or github_pat_…"
                  value={token}
                  onChange={(event) => setToken(event.currentTarget.value)}
                />
              </label>
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Classic token</span> on the bot's
                  account: <span className="font-mono">public_repo</span> if it only works on public
                  repositories, <span className="font-mono">repo</span> if any is private. Nothing
                  else. A token with <span className="font-mono">workflow</span>,{" "}
                  <span className="font-mono">delete_repo</span> or any{" "}
                  <span className="font-mono">admin:</span> scope is refused.
                </p>
                <p>
                  <span className="font-medium text-foreground">Fine-grained token</span>: only when
                  the repositories belong to the bot or to a GitHub organization it is a member of
                  (it cannot work in another person's repository where the bot is a collaborator).
                  Only the chosen repositories, with Contents, Issues and Pull requests read and
                  write; Metadata, Checks, Commit statuses and Actions read; Workflows no access.
                </p>
                <p>
                  In each repository, add the bot as a collaborator with the{" "}
                  <span className="font-medium text-foreground">Write</span> role, never Maintain or
                  Admin. Recommended: a ruleset on the default branch (and the base branch) that
                  requires a pull request with passing checks and blocks direct pushes, force pushes
                  and deletion.
                </p>
              </div>
              {error === null ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => props.onClose()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || token.trim().length === 0}>
              {pending ? "Checking…" : props.replacing ? "Replace token" : "Register"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

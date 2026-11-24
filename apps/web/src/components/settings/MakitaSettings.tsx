import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MakitaAccountGetResult,
  type MakitaAccountView,
  type MakitaAccountWarning,
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

/** Platform → Makita: the bot's GitHub account, «Stop all Makita work» (the Owner's). */
export function PlatformMakitaSection() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : <MakitaAccountPanel environmentId={environmentId} />}
    </SettingsPageContainer>
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

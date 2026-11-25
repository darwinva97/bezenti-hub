import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GitHubIdentityView, GitHubLinkCode } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { errorMessageOf } from "../../lib/errorMessage";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { makitaEnvironment } from "../../state/makita";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

type ViewAnswer = AtomCommandResult<GitHubIdentityView, unknown>;

/** How often the page asks whether the posted code has linked the account yet. */
const WAIT_POLL_MS = 5_000;

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * User settings → Account → «GitHub account» (Makita ticket 08): link the User's own GitHub account
 * by posting a one-time code from it, see the linked login, unlink it.
 */
export function GitHubAccountRow() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <GitHubAccountPanel environmentId={environmentId} />;
}

function GitHubAccountPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const get = useAtomCommand(makitaEnvironment.getGitHubIdentity, "read your GitHub account");
  const linkCode = useAtomCommand(makitaEnvironment.githubLinkCode, "make a link code");
  const unlink = useAtomCommand(makitaEnvironment.unlinkGitHub, "unlink your GitHub account");
  const [view, setView] = useState<GitHubIdentityView | null>(null);
  const [code, setCode] = useState<GitHubLinkCode | null>(null);
  const [login, setLogin] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (cause) => setError(errorMessageOf(cause, "Could not copy it.")),
  });

  const show = (result: ViewAnswer, fallback: string) => {
    if (result._tag === "Success") {
      setView(result.value);
      setError(null);
      if (result.value.linked !== null || result.value.pending?.state !== "waiting") setCode(null);
      return;
    }
    setError(errorMessageOf(squashAtomCommandFailure(result), fallback));
  };
  const loadNow = useEffectEvent((target: EnvironmentId) =>
    get({ environmentId: target, input: {} }),
  );
  const applyLoaded = useEffectEvent((result: ViewAnswer) =>
    show(result, "Could not read your GitHub account."),
  );
  const waiting = view?.pending?.state === "waiting" && view.linked === null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the link when the section opens and, while a code waits, until Makita sees it.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void loadNow(environmentId).then((result) => {
        if (!cancelled) applyLoaded(result);
      });
    };
    load();
    const timer = waiting ? window.setInterval(load, WAIT_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [environmentId, waiting]);

  const ask = async () => {
    setBusy(true);
    const result = await linkCode({ environmentId, input: { login: login.trim() } });
    if (result._tag === "Success") {
      setCode(result.value);
      setAsking(false);
      setError(null);
      show(await get({ environmentId, input: {} }), "Could not read your GitHub account.");
    } else {
      setError(errorMessageOf(squashAtomCommandFailure(result), "Could not make a code."));
    }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    show(await unlink({ environmentId, input: {} }), "Could not unlink your GitHub account.");
    setBusy(false);
  };

  if (view === null) {
    return (
      <SettingsRow
        title="GitHub account"
        description={error ?? "Reading your GitHub account…"}
        control={null}
      />
    );
  }
  const linked = view.linked;
  if (linked !== null) {
    return (
      <SettingsRow
        title="GitHub account"
        description={`Linked to @${linked.login} since ${formatWhen(linked.linkedAt)}. Makita configurations that answer you, or this Space's Members, recognize it.${error === null ? "" : ` ${error}`}`}
        control={
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void remove()}>
            Unlink
          </Button>
        }
      />
    );
  }
  const pending = view.pending;
  const description =
    view.makitaLogin === null
      ? "Makita is not set up on this Hub, so a GitHub account cannot be linked yet."
      : pending?.state === "taken"
        ? `That GitHub account (@${pending.login}) is linked to someone else on this Hub.`
        : pending?.state === "waiting"
          ? `Waiting for @${pending.login} to post the code, until ${formatWhen(pending.expiresAt)}.`
          : "Link your GitHub account so Makita configurations that answer you, or this Space's Members, recognize you. You prove it by posting a one-time code from that account.";
  return (
    <SettingsRow
      title="GitHub account"
      description={error === null ? description : `${description} ${error}`}
      control={
        view.makitaLogin === null || asking ? null : (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => setAsking(true)}>
            Link GitHub account
          </Button>
        )
      }
    >
      {asking ? (
        <form
          className="mt-3 flex max-w-sm flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (login.trim().length > 0) void ask();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium">
            Your GitHub login
            <Input
              aria-label="Your GitHub login"
              nativeInput
              disabled={busy}
              placeholder="octocat"
              value={login}
              onChange={(event) => setLogin(event.currentTarget.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button size="xs" type="submit" disabled={busy || login.trim().length === 0}>
              Get a code
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {code !== null && waiting ? (
        <div className="mt-3 flex max-w-lg flex-col gap-2 text-xs">
          <p>
            {`Signed in to GitHub as @${code.login}, post this comment on any issue of a repository Makita listens to. The code works once, for 15 minutes. Post it only for your own Hub account.`}
          </p>
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono">{code.comment}</code>
            <Button
              size="xs"
              variant="outline"
              onClick={() => copyToClipboard(code.comment, undefined)}
            >
              {isCopied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-muted-foreground">
            Makita reacts with 👍 once your account is linked.
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}

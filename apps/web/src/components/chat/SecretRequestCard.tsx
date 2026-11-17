import { pipe } from "effect/Function";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestAnswerInput,
  secretRequestTargetLabel,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  secretRequestVaultNameProblem,
  secretRequestVaultValueProblem,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  SecretRequestVaultTargets,
  VaultGroupId,
} from "@t3tools/contracts";
import { CheckIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretValueArea } from "../settings/SecretValueArea";
import { WorkLogRow } from "./WorkLog";

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = secretRequestDisplay(item, props.visibility);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "saved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.label} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingSecretRequestForm environmentId={props.environmentId} item={item} />;
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const inputId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  // «Also save to Vault»: only the Vaults the Hub offers this User for this Thread (none for a
  // Member or a Guest, who answer as before). The Hub checks the choice again.
  const loadTargets = useAtomCommand(serverEnvironment.secretRequestVaultTargets, {
    label: "list Vaults for a secret request",
    reportFailure: false,
    reportDefect: false,
  });
  const [targets, setTargets] = useState<SecretRequestVaultTargets["vaults"]>([]);
  const [saveToVault, setSaveToVault] = useState(false);
  const [vaultId, setVaultId] = useState<VaultGroupId | null>(null);
  const [vaultName, setVaultName] = useState(item.secretName ?? "");
  // Asked when the User starts answering (focus enters the card); a failed ask is tried again at
  // the next focus.
  const targetsAsked = useRef(false);
  const askTargets = () => {
    if (targetsAsked.current) return;
    targetsAsked.current = true;
    void loadTargets({
      environmentId: props.environmentId,
      input: { threadId: item.threadId },
    }).then((result) => {
      if (result._tag !== "Success") {
        targetsAsked.current = false;
        return;
      }
      setTargets(result.value.vaults);
      setVaultId((current) => current ?? result.value.vaults[0]?.id ?? null);
    });
  };
  const [secret, setSecret] = useState("");
  const saveProblem = saveToVault
    ? (secretRequestVaultNameProblem(vaultName) ?? secretRequestVaultValueProblem(secret))
    : null;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and click can both submit before a render.
  const inFlight = useRef(false);

  const send = async (
    reply:
      | {
          readonly type: "save";
          readonly secret: string;
          readonly saveToVault?: { readonly vaultId: VaultGroupId; readonly name: string };
        }
      | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setSecret("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), secretRequestFailureMessage, setError);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveToVault && (vaultId === null || saveProblem !== null)) return;
    void send(
      saveToVault && vaultId !== null
        ? { type: "save", secret, saveToVault: { vaultId, name: vaultName } }
        : { type: "save", secret },
    );
  };

  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      autoComplete="off"
      onFocus={askTargets}
      // On click, not pointerdown: the mousedown that follows a pointerdown
      // moves focus back off the input. A click that ends a text selection
      // leaves it alone so the reason can still be copied.
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest("input, textarea, button, a")) return;
        if (window.getSelection()?.isCollapsed === false) return;
        document.getElementById(inputId)?.focus();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          {item.label}
        </label>
        {item.reason.trim() ? (
          <p className="text-sm wrap-anywhere text-muted-foreground">{item.reason}</p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* A text area: a PEM key or a JSON credential keeps its lines (owned-resources 02). Enter
              sends, Shift+Enter starts a line; a paste keeps its own. */}
          <SecretValueArea
            id={inputId}
            placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
            value={secret}
            disabled={submitting}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? `${privacyId} ${errorId}` : privacyId}
            onValueChange={setSecret}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
        </div>
        <Button
          type="submit"
          disabled={submitting || secret.trim().length === 0 || saveProblem !== null}
        >
          Save securely
        </Button>
      </div>
      {targets.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-2">
          <label className="flex items-center gap-2 text-xs font-medium">
            <Checkbox
              aria-label="Also save to Vault"
              checked={saveToVault}
              disabled={submitting}
              onCheckedChange={(checked) => setSaveToVault(checked === true)}
            />
            Also save to Vault
          </label>
          {saveToVault ? (
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
              <div className="min-w-0 sm:w-48">
                <Select
                  disabled={submitting}
                  items={targets.map((target) => ({
                    value: target.id,
                    label: secretRequestTargetLabel(target),
                  }))}
                  value={vaultId}
                  onValueChange={(value) => setVaultId(value)}
                >
                  <SelectTrigger aria-label="Vault">
                    <SelectValue placeholder="Choose a Vault" />
                  </SelectTrigger>
                  <SelectPopup>
                    {targets.map((target) => (
                      <SelectItem key={target.id} value={target.id}>
                        {secretRequestTargetLabel(target)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Input
                  aria-label="Secret name"
                  placeholder="NAME"
                  autoComplete="off"
                  spellCheck={false}
                  value={vaultName}
                  disabled={submitting}
                  aria-invalid={saveProblem !== null || undefined}
                  onChange={(event) => setVaultName(event.currentTarget.value.toUpperCase())}
                />
                {saveProblem === null ? (
                  <p className="text-xs text-muted-foreground">
                    Threads that receive this Vault get it as {vaultName.trim()}.
                  </p>
                ) : (
                  <p className="text-xs text-destructive">{saveProblem}</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {secretRequestPrivacyNote(item)}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting}
          onClick={() => void send({ type: "decline" })}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}

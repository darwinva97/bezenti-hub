import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AccessKey,
  AccessKeyListResult,
  AccessKeyValidity,
  EnvironmentId,
  SpaceId,
} from "@t3tools/contracts";
import { accessKeySetup, gatewayOrigin, sendsKeyInClear } from "@t3tools/shared/aiGatewayAccessKey";
import { useAtomValue } from "@effect/atom-react";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readHubLinkOrigin } from "../../hubLinks";
import { errorMessageOf } from "../../lib/errorMessage";
import { aiGatewayEnvironment } from "../../state/aiGateway";
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
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Tool = "claude-code" | "codex" | "other";
const TOOLS: ReadonlyArray<readonly [Tool, string]> = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["other", "Other clients"],
];
const SETUP_HINTS: Readonly<Record<Tool, string>> = {
  "claude-code": "Put this in ~/.claude/settings.json (merge it into the env of a file you have).",
  codex: "Put this in ~/.codex/config.toml; the key goes in your shell's environment, not there.",
  other: "Any client that speaks the OpenAI, Anthropic or Gemini API: its base URL and the key.",
};
/** ADR 0005: a key that reaches a subscription shares it with whoever holds the key. */
const SUBSCRIPTION_WARNING =
  "A key here reaches this Space's subscription AI accounts: whoever holds it uses that subscription too. Sharing a subscription with people outside may break the provider's terms; the provider may suspend the account. API keys are the compliant choice.";
const IN_CLEAR_WARNING =
  "This Hub is reached over plain http: the key would cross the network unencrypted. Use the Hub's https address.";
const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;

type ListAnswer = AtomCommandResult<AccessKeyListResult, unknown>;

/** Whether a failure is the Hub saying the viewer may not see this Space's keys. */
const isForbidden = (result: ListAnswer) => {
  if (result._tag === "Success") return false;
  const failure = squashAtomCommandFailure(result) as {
    readonly _tag?: string;
    readonly reason?: string;
  };
  return failure?._tag === "AccessKeyError" && failure.reason === "forbidden";
};

const formatWhen = (iso: string | null) =>
  iso === null
    ? "Never"
    : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** «Expires in 3 days», «Expires in 5 hours», «Expired on …», in the viewer's time. */
const expiryText = (expiresAt: string, now: number) => {
  const at = Date.parse(expiresAt);
  if (at <= now) return `Expired on ${formatWhen(expiresAt)}`;
  const left = at - now;
  if (left >= DAY_MS) {
    const days = Math.floor(left / DAY_MS);
    return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
  }
  const hours = Math.max(1, Math.floor(left / 3_600_000));
  return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
};

/** The end of a local calendar day (`YYYY-MM-DD`) as a UTC instant; null when not a date. */
const endOfLocalDay = (day: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (match === null) return null;
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(end.getTime()) ? null : end.toISOString();
};

function useAccessKeyCommands() {
  return {
    list: useAtomCommand(aiGatewayEnvironment.listAccessKeys, "list the access keys"),
    create: useAtomCommand(aiGatewayEnvironment.createAccessKey, "make an access key"),
    revoke: useAtomCommand(aiGatewayEnvironment.revokeAccessKey, "revoke an access key"),
  };
}

/**
 * Space settings → AI accounts → «Access keys» (access-keys ticket 01): keys of this Space's AI
 * gateway for someone with or without a Hub account. Whoever manages the Space makes them; the
 * key is shown once, with its setup; the Hub keeps only its hash. Hidden to whoever may not see
 * the Space's keys.
 */
export function AccessKeysSection({ spaceId }: { readonly spaceId: SpaceId }) {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : (
    <AccessKeysPanel environmentId={environmentId} spaceId={spaceId} />
  );
}

function AccessKeysPanel({
  environmentId,
  spaceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
}) {
  const commands = useAccessKeyCommands();
  // The session may hand out credentials at all (access:write); the Hub decides the rest.
  const mayCreate = useAtomValue(
    aiGatewayEnvironment.createAccessKey.permissionAtom(environmentId),
  );
  const mayRevoke = useAtomValue(
    aiGatewayEnvironment.revokeAccessKey.permissionAtom(environmentId),
  );
  const [listed, setListed] = useState<AccessKeyListResult | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [made, setMade] = useState<{ readonly key: AccessKey; readonly secret: string } | null>(
    null,
  );
  const [revoking, setRevoking] = useState<AccessKey | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const origin = gatewayOrigin(readHubLinkOrigin(environmentId) ?? "");

  const showListed = (result: ListAnswer) => {
    setNow(Date.now());
    if (result._tag === "Success") {
      setListed(result.value);
      setHidden(false);
      setError(null);
      return;
    }
    if (isForbidden(result)) {
      setHidden(true);
      return;
    }
    setError(errorMessageOf(squashAtomCommandFailure(result), "Could not read the access keys."));
  };
  const applyListed = useEffectEvent(showListed);
  const loadKeys = useEffectEvent((target: EnvironmentId, space: SpaceId, ended: boolean) =>
    commands.list({
      environmentId: target,
      input: { spaceId: space, ...(ended ? { includeEnded: true } : {}) },
    }),
  );
  const load = async () =>
    showListed(
      await commands.list({
        environmentId,
        input: { spaceId, ...(showEnded ? { includeEnded: true } : {}) },
      }),
    );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Space's access keys from the Hub when the section opens or «Show ended» changes.
  useEffect(() => {
    let cancelled = false;
    void loadKeys(environmentId, spaceId, showEnded).then((result) => {
      if (!cancelled) applyListed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, spaceId, showEnded]);

  const revoke = async (key: AccessKey) => {
    setRevokePending(true);
    const result = await commands.revoke({ environmentId, input: { keyId: key.keyId } });
    setRevokePending(false);
    setRevoking(null);
    if (result._tag === "Success") {
      if (made?.key.keyId === key.keyId) setMade(null);
      await load();
    } else {
      setError(errorMessageOf(squashAtomCommandFailure(result), "Could not revoke the key."));
    }
  };

  if (hidden) return null;
  const space = listed?.space ?? null;
  return (
    <SettingsSection id="access-keys" title="Access keys">
      <SettingsRow
        title="Keys for people outside this Space"
        description="Give someone this Space's AI accounts for their own agent, with or without a Hub account: they paste the setup into Claude Code, Codex or another client. Each key is valid until a date you choose and its use counts on the key. A key is shown once, when you make it."
        status={
          error === null ? null : (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          )
        }
      />
      {space?.subscription === true ? (
        <p className="mx-4 mb-2 text-xs text-warning-foreground" role="note">
          {SUBSCRIPTION_WARNING}
        </p>
      ) : null}
      {mayCreate && space?.canManage === true ? (
        <NewAccessKeyForm
          environmentId={environmentId}
          spaceId={spaceId}
          create={commands.create}
          onMade={(key, secret) => {
            setMade({ key, secret });
            void load();
          }}
        />
      ) : null}
      {made === null ? null : (
        <NewKeyPanel
          made={made}
          origin={origin}
          onDone={() => setMade(null)}
          onError={(message) => setError(message)}
        />
      )}
      <div className="flex items-center gap-2 px-4 pb-2 text-xs">
        <label className="flex items-center gap-2">
          <Checkbox
            aria-label="Show ended keys"
            checked={showEnded}
            onCheckedChange={(checked) => setShowEnded(checked === true)}
          />
          Show ended keys
        </label>
      </div>
      {listed === null ? null : listed.keys.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No access key yet.</p>
      ) : (
        <ul aria-label="Access keys" className="flex flex-col gap-2 px-4 pb-4">
          {listed.keys.map((key) => (
            <li
              key={key.keyId}
              aria-label={key.label}
              className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">
                  {key.label}{" "}
                  <span className="font-mono text-xs text-muted-foreground">…{key.hint}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {[
                    `By ${key.createdByName ?? key.createdBy}`,
                    key.revokedAt === null ? null : `Revoked ${formatWhen(key.revokedAt)}`,
                    `Last used ${formatWhen(key.lastUsedAt)}`,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                  {key.revokedAt === null ? (
                    <>
                      {" · "}
                      <Tooltip>
                        <TooltipTrigger render={<span>{expiryText(key.expiresAt, now)}</span>} />
                        <TooltipPopup>
                          {`${key.expiresAt.slice(0, 16).replace("T", " ")} UTC`}
                        </TooltipPopup>
                      </Tooltip>
                    </>
                  ) : null}
                </span>
              </div>
              {mayRevoke && key.revokedAt === null ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  aria-label={`Revoke ${key.label}`}
                  onClick={() => setRevoking(key)}
                >
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !revokePending) setRevoking(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke «{revoking?.label}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Whoever uses it is refused from their next request. This cannot be undone: make a new
              key to give access again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={revokePending}
              render={<Button variant="outline" disabled={revokePending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={revokePending || revoking === null}
              onClick={() => {
                if (revoking !== null) void revoke(revoking);
              }}
            >
              Revoke key
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/** The key, once, with its setup for each client. */
function NewKeyPanel(props: {
  readonly made: { readonly key: AccessKey; readonly secret: string };
  readonly origin: string | null;
  readonly onDone: () => void;
  readonly onError: (message: string) => void;
}) {
  const { made, origin } = props;
  const [tool, setTool] = useState<Tool>("claude-code");
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    onError: (cause) => props.onError(errorMessageOf(cause, "Could not copy it.")),
  });
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (what: string, text: string) => {
    setCopied(what);
    copyToClipboard(text, what);
  };
  const setup = origin === null ? null : accessKeySetup(origin, made.secret);
  const file =
    setup === null
      ? null
      : tool === "claude-code"
        ? setup.claudeCode
        : tool === "codex"
          ? setup.codex
          : setup.other;
  const shell = tool === "codex" ? (setup?.codexShell ?? null) : null;
  return (
    <section
      aria-label="New access key"
      className="mx-4 mb-4 flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
    >
      <p className="font-medium">
        Copy «{made.key.label}» now: it is not shown again. Anyone with it uses{" "}
        {made.key.spaceName ?? "this Space"}'s AI accounts until {formatWhen(made.key.expiresAt)}.
      </p>
      {origin !== null && sendsKeyInClear(origin) ? (
        <p className="text-xs text-destructive" role="alert">
          {IN_CLEAR_WARNING}
        </p>
      ) : null}
      <code aria-label="Key" className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
        {made.secret}
      </code>
      <ToggleGroup
        aria-label="Setup for"
        value={[tool]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "claude-code" || value === "codex" || value === "other") setTool(value);
        }}
      >
        {TOOLS.map(([value, label]) => (
          <Toggle key={value} value={value}>
            {label}
          </Toggle>
        ))}
      </ToggleGroup>
      {file === null ? null : (
        <>
          <p className="text-xs text-muted-foreground">{SETUP_HINTS[tool]}</p>
          <pre
            aria-label="Setup"
            className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs"
          >
            {file}
          </pre>
          {shell === null ? null : (
            <pre
              aria-label="Shell line"
              className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs"
            >
              {shell}
            </pre>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => copy("key", made.secret)}>
          {isCopied && copied === "key" ? "Copied" : "Copy key"}
        </Button>
        {file === null ? null : (
          <Button size="sm" variant="outline" onClick={() => copy("setup", file)}>
            {isCopied && copied === "setup" ? "Copied" : "Copy setup"}
          </Button>
        )}
        {shell === null ? null : (
          <Button size="sm" variant="outline" onClick={() => copy("shell", shell)}>
            {isCopied && copied === "shell" ? "Copied" : "Copy shell line"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

function NewAccessKeyForm(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly create: ReturnType<typeof useAccessKeyCommands>["create"];
  readonly onMade: (key: AccessKey, secret: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"days" | "until">("days");
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [until, setUntil] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validity: AccessKeyValidity | null = (() => {
    if (mode === "days") {
      const value = Number(days);
      return Number.isInteger(value) && value >= 1 && value <= 366 ? { days: value } : null;
    }
    const end = endOfLocalDay(until);
    return end === null ? null : { until: end };
  })();
  const ready = label.trim().length > 0 && validity !== null;
  return (
    <form
      aria-label="Create an access key"
      className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (validity === null) return;
        setPending(true);
        setError(null);
        void props
          .create({
            environmentId: props.environmentId,
            input: { spaceId: props.spaceId, label: label.trim(), validity },
          })
          .then((result) => {
            if (result._tag === "Success") {
              setLabel("");
              props.onMade(result.value.created, Redacted.value(result.value.key));
            } else {
              setError(errorMessageOf(squashAtomCommandFailure(result), "Could not make the key."));
            }
          })
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Who it is for
        <Input
          aria-label="Who it is for"
          nativeInput
          disabled={pending}
          maxLength={80}
          placeholder="A partner's name"
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
      </label>
      <div className="flex flex-col gap-1 text-xs font-medium">
        Valid
        <ToggleGroup
          aria-label="Valid"
          value={[mode]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "days" || value === "until") setMode(value);
          }}
        >
          <Toggle value="days">For days</Toggle>
          <Toggle value="until">Until a date</Toggle>
        </ToggleGroup>
      </div>
      {mode === "days" ? (
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-28">
          Days (1 to 366)
          <Input
            aria-label="Days"
            nativeInput
            type="number"
            min={1}
            max={366}
            disabled={pending}
            value={days}
            onChange={(event) => setDays(event.currentTarget.value)}
          />
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-44">
          Until the end of
          <Input
            aria-label="Until"
            nativeInput
            type="date"
            disabled={pending}
            value={until}
            onChange={(event) => setUntil(event.currentTarget.value)}
          />
        </label>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={pending || !ready} size="sm" type="submit">
          Create key
        </Button>
        {error === null ? null : (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ACCESS_KEY_MAX_CAP,
  type AccessKey,
  type AccessKeyAccountOption,
  type AccessKeyLimits,
  type AccessKeyListResult,
  type AccessKeyModelOptions,
  type AccessKeyValidity,
  type AiAccountId,
  accessKeyAllowsAllModels,
  accessKeyModelAllowed,
  accessKeyModelEntryValid,
  type EnvironmentId,
  type SpaceId,
} from "@t3tools/contracts";
import { accessKeySetup, gatewayOrigin, sendsKeyInClear } from "@t3tools/shared/aiGatewayAccessKey";
import { formatTokens } from "@t3tools/client-runtime/ai-usage-view";
import { useAtomValue } from "@effect/atom-react";
import * as Redacted from "effect/Redacted";
import { EllipsisIcon, PlusIcon } from "lucide-react";
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
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChipsMultiSelect } from "./ChipsMultiSelect";
import { InfoTip } from "./InfoTip";
import { SettingsSection } from "./settingsLayout";

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
    update: useAtomCommand(aiGatewayEnvironment.updateAccessKey, "change an access key"),
    options: useAtomCommand(
      aiGatewayEnvironment.accessKeyModelOptions,
      "read what a key may reach",
    ),
  };
}

/** The models these accounts serve, once each, in their order. */
const catalogOf = (accounts: ReadonlyArray<AccessKeyAccountOption>) => [
  ...new Set(accounts.flatMap((account) => account.models)),
];

/** The Space's accounts a key reaches: all of them (null), or those of its list still there. */
const reachedBy = (
  options: AccessKeyModelOptions | null,
  accounts: ReadonlyArray<AiAccountId> | null,
) =>
  (options?.accounts ?? []).filter((account) => accounts === null || accounts.includes(account.id));

/** What a key's setup pins: the models it may use that the accounts it reaches serve. */
const usableModels = (options: AccessKeyModelOptions | null, key: AccessKey) =>
  catalogOf(reachedBy(options, key.accounts)).filter((model) =>
    accessKeyModelAllowed(key.models, model),
  );

/**
 * What a key used (access-keys ticket 04), as its caps count tokens; cache reads apart, and the
 * requests with no usage said with their estimate, never as zero.
 */
const usageText = (usage: AccessKey["usage"]) => {
  if (usage === undefined) return null;
  const parts = [
    `Today ${formatTokens(usage.day)}`,
    `this week ${formatTokens(usage.week)}`,
    `this month ${formatTokens(usage.month)}`,
    `in total ${formatTokens(usage.total)} tokens`,
  ];
  if (usage.cacheReadTokens > 0) parts.push(`${formatTokens(usage.cacheReadTokens)} cache read`);
  if (usage.unknownRequests > 0) {
    parts.push(
      `${usage.unknownRequests} without usage (≈${formatTokens(usage.estimatedTokens)} estimated)`,
    );
  }
  return parts.join(" · ");
};

const CAP_LABELS: ReadonlyArray<readonly [keyof AccessKeyLimits, string]> = [
  ["total", "Total"],
  ["day", "Per day"],
  ["week", "Per week"],
  ["month", "Per month"],
];

/**
 * Each cap of a key as the list says it (access-keys ticket 05): used of how much, what is left,
 * and when its period resets, in local time; the total never resets by itself.
 */
const capsText = (key: AccessKey): ReadonlyArray<string> =>
  CAP_LABELS.flatMap(([kind, label]) => {
    const amount = key.limits[kind];
    if (amount === null) return [];
    const used = key.usage?.[kind] ?? 0;
    const left = Math.max(0, amount - used);
    const reset =
      kind === "total" || key.usage === undefined
        ? ""
        : ` · resets ${formatWhen(key.usage.resets[kind])}`;
    return [
      `${label}: ${formatTokens(used)} of ${formatTokens(amount)} · ${formatTokens(left)} left${reset}`,
    ];
  });

/** The form's caps: whole numbers of tokens, empty for none; null when one is not valid. */
const limitsOf = (
  caps: Readonly<Record<keyof AccessKeyLimits, string>>,
): AccessKeyLimits | null => {
  const limits: Record<keyof AccessKeyLimits, number | null> = {
    total: null,
    day: null,
    week: null,
    month: null,
  };
  for (const [kind] of CAP_LABELS) {
    const text = caps[kind].trim();
    if (text === "") continue;
    const amount = Number(text);
    if (!Number.isInteger(amount) || amount < 1 || amount > ACCESS_KEY_MAX_CAP) return null;
    limits[kind] = amount;
  }
  return limits;
};

/** A key's models as the list says them. */
const modelsText = (entries: ReadonlyArray<string>) =>
  accessKeyAllowsAllModels(entries) ? "All models" : entries.join(", ");

/** A model's family for the picker: `claude-sonnet`, `gpt`, `gemini`… */
const familyOf = (model: string) => {
  const parts = model.split("-");
  return parts[0] === "claude" && parts.length > 2
    ? `${parts[0]}-${parts[1]}`
    : (parts[0] ?? model);
};

/**
 * Space settings → AI accounts → «Access keys» (access-keys ticket 01): keys of this Space's AI
 * gateway for someone with or without a Hub account. Whoever manages the Space makes them; the
 * key is shown once, with its setup; the Hub keeps only its hash. Hidden to whoever may not see
 * the Space's keys.
 */
export function AccessKeysSection({ spaceId }: { readonly spaceId?: SpaceId }) {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : (
    <AccessKeysPanel environmentId={environmentId} spaceId={spaceId} />
  );
}

/** How a key's Space stands, said beside it in the Owner's list of every Space (ticket 07). */
const SPACE_STATES: Readonly<Record<NonNullable<AccessKey["spaceState"]>, string | null>> = {
  open: null,
  archived: "archived: refused until restored",
  frozen: "closed",
  gone: "deleted",
};

/** One Space's list, or (no Space) the Owner's list of every Space's keys, to see and revoke. */
const listInput = (space: SpaceId | undefined, ended: boolean) => ({
  ...(space === undefined ? {} : { spaceId: space }),
  ...(ended ? { includeEnded: true } : {}),
});

function AccessKeysPanel({
  environmentId,
  spaceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId | undefined;
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
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AccessKey | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [options, setOptions] = useState<AccessKeyModelOptions | null>(null);
  const [editing, setEditing] = useState<{
    readonly key: AccessKey;
    readonly mode: "renew" | "edit";
  } | null>(null);
  const mayUpdate = useAtomValue(
    aiGatewayEnvironment.updateAccessKey.permissionAtom(environmentId),
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    onError: (cause) => setError(errorMessageOf(cause, "Could not copy it.")),
  });
  const [copied, setCopied] = useState<string | null>(null);

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
  const loadKeys = useEffectEvent(
    (target: EnvironmentId, space: SpaceId | undefined, ended: boolean) =>
      commands.list({ environmentId: target, input: listInput(space, ended) }),
  );
  const load = async () =>
    showListed(await commands.list({ environmentId, input: listInput(spaceId, showEnded) }));

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

  // What a key may reach, for the form and the setup: only for whoever may make keys here.
  const canManage = listed?.space?.canManage === true;
  const loadOptions = useEffectEvent((target: EnvironmentId, space: SpaceId | undefined) =>
    space === undefined
      ? Promise.resolve(null)
      : commands.options({ environmentId: target, input: { spaceId: space } }),
  );
  const applyOptions = useEffectEvent(
    (result: AtomCommandResult<AccessKeyModelOptions, unknown> | null) => {
      if (result !== null && result._tag === "Success") setOptions(result.value);
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Space's accounts and models from the Hub once the viewer may make keys there.
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    void loadOptions(environmentId, spaceId).then((result) => {
      if (!cancelled) applyOptions(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, spaceId, canManage]);

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
  const mayMake = mayCreate && spaceId !== undefined && space?.canManage === true;
  const description =
    spaceId === undefined
      ? "The access keys of every Space, with the state of their Space. Each Space's own settings make and change them; you may revoke any here."
      : "Give someone this Space's AI accounts for their own agent, with or without a Hub account: they paste the setup into Claude Code, Codex or another client. Each key is valid until a date you choose and its use counts on the key. A key is shown once, when you make it.";
  return (
    <SettingsSection
      id="access-keys"
      title="Access keys"
      titleAction={
        <InfoTip
          label={
            spaceId === undefined
              ? "About every Space's access keys"
              : "About keys for people outside this Space"
          }
        >
          {description}
        </InfoTip>
      }
      headerAction={
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              aria-label="Show ended keys"
              checked={showEnded}
              onCheckedChange={(checked) => setShowEnded(checked === true)}
            />
            Show ended
          </label>
          {mayMake ? (
            <Button size="xs" onClick={() => setCreating(true)}>
              <PlusIcon />
              New access key
            </Button>
          ) : null}
        </div>
      }
    >
      {error === null ? null : (
        <p className="px-4 py-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {listed === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      ) : listed.keys.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No access key yet.</p>
      ) : (
        <ul aria-label="Access keys" className="divide-y divide-border/50">
          {listed.keys.map((key) => (
            <AccessKeyRow
              key={key.keyId}
              accessKey={key}
              allSpaces={spaceId === undefined}
              now={now}
              copy={
                origin === null || key.revokedAt !== null
                  ? null
                  : {
                      copied: isCopied && copied === key.keyId,
                      onCopy: () => {
                        // The key is never shown again: the setup holds a placeholder for it.
                        setCopied(key.keyId);
                        copyToClipboard(
                          accessKeySetup(origin, null, usableModels(options, key)).claudeCode,
                          key.keyId,
                        );
                      },
                    }
              }
              onRenew={
                mayUpdate && canManage && key.revokedAt === null
                  ? () => setEditing({ key, mode: "renew" })
                  : null
              }
              onEdit={
                mayUpdate && canManage && key.revokedAt === null
                  ? () => setEditing({ key, mode: "edit" })
                  : null
              }
              onRevoke={mayRevoke && key.revokedAt === null ? () => setRevoking(key) : null}
            />
          ))}
        </ul>
      )}
      {/* «New access key», then the key once, in one dialog: it closes only by «Done». */}
      {mayMake || made !== null ? (
        <Dialog
          open={creating || made !== null}
          disablePointerDismissal={made !== null}
          onOpenChange={(open) => {
            if (!open && made === null) setCreating(false);
          }}
        >
          <DialogPopup className="max-w-2xl" showCloseButton={made === null}>
            {made === null ? (
              spaceId === undefined || space === null ? null : (
                <NewAccessKeyForm
                  environmentId={environmentId}
                  spaceId={spaceId}
                  description={description}
                  accounts={options?.accounts ?? []}
                  spaceHasSubscription={space.subscription}
                  create={commands.create}
                  onCancel={() => setCreating(false)}
                  onMade={(key, secret) => {
                    setMade({ key, secret });
                    void load();
                  }}
                />
              )
            ) : (
              <NewKeyPanel
                made={made}
                origin={origin}
                models={usableModels(options, made.key)}
                onDone={() => {
                  setMade(null);
                  setCreating(false);
                }}
                onError={(message) => setError(message)}
              />
            )}
          </DialogPopup>
        </Dialog>
      ) : null}
      {editing === null ? null : (
        <EditAccessKeyDialog
          accessKey={editing.key}
          mode={editing.mode}
          environmentId={environmentId}
          accounts={options?.accounts ?? []}
          update={commands.update}
          onClose={() => setEditing(null)}
          onChanged={() => void load()}
        />
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

/**
 * One key, dense: its label and hint with its expiry; what it reaches; its caps; its use; who
 * made it. «Copy setup» stays at hand, the rest in its «⋯» menu.
 */
function AccessKeyRow(props: {
  readonly accessKey: AccessKey;
  /** The Owner's list of every Space: say each key's Space. */
  readonly allSpaces: boolean;
  readonly now: number;
  readonly copy: { readonly copied: boolean; readonly onCopy: () => void } | null;
  readonly onRenew: (() => void) | null;
  readonly onEdit: (() => void) | null;
  readonly onRevoke: (() => void) | null;
}) {
  const key = props.accessKey;
  const caps = capsText(key);
  const usage = usageText(key.usage);
  const expired = key.revokedAt === null && Date.parse(key.expiresAt) <= props.now;
  const hasMenu = props.onRenew !== null || props.onEdit !== null || props.onRevoke !== null;
  return (
    <li
      aria-label={key.label}
      className="flex flex-col gap-2 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-4 sm:px-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{key.label}</span>
          <span className="font-mono text-xs text-muted-foreground">…{key.hint}</span>
          {key.revokedAt === null ? (
            <Tooltip>
              <TooltipTrigger
                render={<Badge variant={expired ? "error" : "secondary"} size="sm" />}
              >
                {expiryText(key.expiresAt, props.now)}
              </TooltipTrigger>
              <TooltipPopup>{`${key.expiresAt.slice(0, 16).replace("T", " ")} UTC`}</TooltipPopup>
            </Tooltip>
          ) : (
            <Badge variant="error" size="sm">
              Revoked {formatWhen(key.revokedAt)}
            </Badge>
          )}
          {props.allSpaces ? (
            <span className="text-xs text-muted-foreground">
              {[
                key.spaceName ?? "A Space that no longer exists",
                key.spaceState === undefined ? null : SPACE_STATES[key.spaceState],
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {modelsText(key.models)}
          {" · "}
          {key.reaches === null
            ? "All of this Space's AI accounts"
            : key.reaches.map((reach, index) => (
                <span key={reach.id}>
                  {index === 0 ? "" : ", "}
                  {reach.inSpace ? (
                    (reach.name ?? reach.id)
                  ) : (
                    <span className="line-through">
                      {reach.name ?? reach.id} (No longer in this Space)
                    </span>
                  )}
                </span>
              ))}
        </span>
        <span className="text-xs text-muted-foreground">
          {caps.length === 0 ? "No token limit" : caps.join("; ")}
        </span>
        {usage === null ? null : (
          <span className="text-xs text-muted-foreground" aria-label="Usage">
            {usage}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {`By ${key.createdByName ?? key.createdBy} · Last used ${formatWhen(key.lastUsedAt)}`}
        </span>
      </div>
      {props.copy === null && !hasMenu ? null : (
        <div className="flex shrink-0 items-center gap-1">
          {props.copy === null ? null : (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Copy setup for ${key.label}`}
              onClick={props.copy.onCopy}
            >
              {props.copy.copied ? "Copied" : "Copy setup"}
            </Button>
          )}
          {hasMenu ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    aria-label={`Actions for ${key.label}`}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end" sideOffset={6}>
                {props.onRenew === null ? null : (
                  <MenuItem aria-label={`Renew ${key.label}`} onClick={props.onRenew}>
                    Renew…
                  </MenuItem>
                )}
                {props.onEdit === null ? null : (
                  <MenuItem aria-label={`Edit ${key.label}`} onClick={props.onEdit}>
                    Edit…
                  </MenuItem>
                )}
                {props.onRevoke === null ? null : (
                  <MenuItem
                    aria-label={`Revoke ${key.label}`}
                    variant="destructive"
                    onClick={props.onRevoke}
                  >
                    Revoke…
                  </MenuItem>
                )}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** The key, once, with its setup for each client. */
function NewKeyPanel(props: {
  readonly made: { readonly key: AccessKey; readonly secret: string };
  readonly origin: string | null;
  /** The models the key may use that the Space's accounts serve: the setup pins them. */
  readonly models: ReadonlyArray<string>;
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
  const setup = origin === null ? null : accessKeySetup(origin, made.secret, props.models);
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
    <>
      <DialogHeader>
        <DialogTitle>Copy «{made.key.label}» now</DialogTitle>
        <DialogDescription>
          It is not shown again. Anyone with it uses {made.key.spaceName ?? "this Space"}'s AI
          accounts until {formatWhen(made.key.expiresAt)}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <section aria-label="New access key" className="flex flex-col gap-3 text-sm">
          {origin !== null && sendsKeyInClear(origin) ? (
            <p className="text-xs text-destructive" role="alert">
              {IN_CLEAR_WARNING}
            </p>
          ) : null}
          <div className="flex items-start gap-2">
            <code
              aria-label="Key"
              className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs"
            >
              {made.secret}
            </code>
            <Button size="xs" variant="outline" onClick={() => copy("key", made.secret)}>
              {isCopied && copied === "key" ? "Copied" : "Copy key"}
            </Button>
          </div>
          <ToggleGroup
            aria-label="Setup for"
            size="sm"
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
                className="max-h-56 overflow-auto rounded bg-muted px-2 py-1 font-mono text-xs"
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
        </section>
      </DialogPanel>
      <DialogFooter>
        {file === null ? null : (
          <Button variant="outline" onClick={() => copy("setup", file)}>
            {isCopied && copied === "setup" ? "Copied" : "Copy setup"}
          </Button>
        )}
        {shell === null ? null : (
          <Button variant="outline" onClick={() => copy("shell", shell)}>
            {isCopied && copied === "shell" ? "Copied" : "Copy shell line"}
          </Button>
        )}
        <Button onClick={props.onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

/**
 * The models a key may use (access-keys ticket 02): «All models» by an explicit choice, or the
 * Space's catalog by family in a searchable multi-select, plus patterns typed there (`claude-sonnet-*`).
 */
function ModelPicker(props: {
  readonly catalog: ReadonlyArray<string>;
  readonly all: boolean;
  readonly entries: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onAll: (all: boolean) => void;
  readonly onEntries: (entries: ReadonlyArray<string>) => void;
}) {
  const families = [...new Set(props.catalog.map(familyOf))];
  return (
    <div className="flex w-full flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
        Models
        <ToggleGroup
          aria-label="Models"
          size="sm"
          value={[props.all ? "all" : "choose"]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "all" || value === "choose") props.onAll(value === "all");
          }}
        >
          <Toggle value="choose">Choose models</Toggle>
          <Toggle value="all">All models</Toggle>
        </ToggleGroup>
      </div>
      {props.all ? null : (
        <ChipsMultiSelect
          label="Search models"
          placeholder="Search models, or type a pattern such as claude-sonnet-*"
          empty="No model matches."
          groups={families.map((family) => ({
            value: family,
            items: props.catalog.filter((model) => familyOf(model) === family),
          }))}
          value={props.entries}
          onValueChange={props.onEntries}
          disabled={props.disabled}
          create={{
            // A pattern (`claude-sonnet-*`) or an exact name the catalog does not list yet.
            accepts: (text) => text.length <= 256 && text !== "*" && accessKeyModelEntryValid(text),
            label: (text) => `Add «${text}» as a pattern`,
          }}
        />
      )}
    </div>
  );
}

/**
 * The AI accounts a key reaches (access-keys ticket 03): all of the Space's own, now and later, by
 * default, or a list of them.
 */
function AccountPicker(props: {
  readonly accounts: ReadonlyArray<AccessKeyAccountOption>;
  readonly all: boolean;
  readonly chosen: ReadonlyArray<AiAccountId>;
  readonly disabled: boolean;
  readonly onAll: (all: boolean) => void;
  readonly onChosen: (chosen: ReadonlyArray<AiAccountId>) => void;
}) {
  const labelOf = (id: string) => {
    const account = props.accounts.find((entry) => entry.id === id);
    if (account === undefined) return id;
    return account.type === "subscription" ? `${account.name} (subscription)` : account.name;
  };
  return (
    <div className="flex w-full flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
        AI accounts
        <ToggleGroup
          aria-label="AI accounts"
          size="sm"
          value={[props.all ? "all" : "choose"]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "all" || value === "choose") props.onAll(value === "all");
          }}
        >
          <Toggle value="all">All of this Space's AI accounts</Toggle>
          <Toggle value="choose">Choose accounts</Toggle>
        </ToggleGroup>
      </div>
      {props.all ? null : (
        <ChipsMultiSelect
          label="Search AI accounts"
          placeholder="Search this Space's AI accounts"
          empty="No AI account matches."
          groups={[{ value: "", items: props.accounts.map((account) => account.id) }]}
          labelOf={labelOf}
          value={props.chosen}
          onValueChange={(next) => props.onChosen(next as ReadonlyArray<AiAccountId>)}
          disabled={props.disabled}
        />
      )}
    </div>
  );
}

type CapsText = Readonly<Record<keyof AccessKeyLimits, string>>;

/** The caps' text fields, from a key's caps (empty: none). */
const capsTextOf = (limits: AccessKeyLimits): CapsText => ({
  total: limits.total === null ? "" : String(limits.total),
  day: limits.day === null ? "" : String(limits.day),
  week: limits.week === null ? "" : String(limits.week),
  month: limits.month === null ? "" : String(limits.month),
});

/** Token caps (access-keys ticket 05): any of the four, or «No token limit» chosen explicitly. */
function CapsFields(props: {
  readonly caps: CapsText;
  readonly unlimited: boolean;
  readonly disabled: boolean;
  readonly only?: ReadonlyArray<keyof AccessKeyLimits>;
  readonly onCaps: (caps: CapsText) => void;
  readonly onUnlimited: (unlimited: boolean) => void;
}) {
  return (
    <fieldset className="grid w-full grid-cols-2 items-end gap-2 text-xs sm:grid-cols-4">
      <legend className="mb-1 font-medium">Token caps</legend>
      {CAP_LABELS.filter(([kind]) => props.only === undefined || props.only.includes(kind)).map(
        ([kind, label]) => (
          <label key={kind} className="flex flex-col gap-1 text-muted-foreground">
            {label}
            <Input
              aria-label={`${label} tokens`}
              nativeInput
              type="number"
              min={1}
              disabled={props.disabled || props.unlimited}
              placeholder="No cap"
              value={props.caps[kind]}
              onChange={(event) =>
                props.onCaps({ ...props.caps, [kind]: event.currentTarget.value })
              }
            />
          </label>
        ),
      )}
      {props.only === undefined ? (
        <label className="col-span-full flex items-center gap-2">
          <Checkbox
            aria-label="No token limit"
            checked={props.unlimited}
            disabled={props.disabled}
            onCheckedChange={(checked) => props.onUnlimited(checked === true)}
          />
          No token limit
        </label>
      ) : null}
    </fieldset>
  );
}

/**
 * «Renew» and «Edit» (access-keys ticket 06): a new validity, with the total used and the option
 * to raise it; or caps, models, accounts and label. The key itself never changes.
 */
function EditAccessKeyDialog(props: {
  readonly accessKey: AccessKey;
  readonly mode: "renew" | "edit";
  readonly environmentId: EnvironmentId;
  readonly accounts: ReadonlyArray<AccessKeyAccountOption>;
  readonly update: ReturnType<typeof useAccessKeyCommands>["update"];
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const key = props.accessKey;
  const [label, setLabel] = useState(key.label);
  const [allModels, setAllModels] = useState(accessKeyAllowsAllModels(key.models));
  const [entries, setEntries] = useState<ReadonlyArray<string>>(
    accessKeyAllowsAllModels(key.models) ? [] : key.models,
  );
  const [allAccounts, setAllAccounts] = useState(key.accounts === null);
  const [chosen, setChosen] = useState<ReadonlyArray<AiAccountId>>(key.accounts ?? []);
  const [caps, setCaps] = useState<CapsText>(capsTextOf(key.limits));
  const noCaps = CAP_LABELS.every(([kind]) => key.limits[kind] === null);
  const [unlimited, setUnlimited] = useState(noCaps);
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limits = unlimited ? null : limitsOf(caps);
  const models: ReadonlyArray<string> = allModels ? ["*"] : entries;
  const reached = allAccounts
    ? props.accounts
    : props.accounts.filter((account) => chosen.includes(account.id));
  const renewDays = Number(days);
  const renewReady = Number.isInteger(renewDays) && renewDays >= 1 && renewDays <= 366;
  const capsReady =
    unlimited || (limits !== null && CAP_LABELS.some(([kind]) => limits[kind] !== null));
  const ready =
    props.mode === "renew"
      ? renewReady && (noCaps || limits !== null)
      : label.trim().length > 0 &&
        models.length > 0 &&
        capsReady &&
        (allAccounts || chosen.length > 0);
  const submit = () => {
    const input =
      props.mode === "renew"
        ? {
            keyId: key.keyId,
            validity: { days: renewDays },
            ...(limits === null || noCaps ? {} : { limits }),
          }
        : {
            keyId: key.keyId,
            label: label.trim(),
            models,
            accounts: allAccounts ? null : chosen,
            ...(unlimited || limits === null ? { unlimited: true } : { limits }),
          };
    setPending(true);
    setError(null);
    void props
      .update({ environmentId: props.environmentId, input })
      .then((result) => {
        if (result._tag === "Success") {
          props.onChanged();
          props.onClose();
        } else {
          setError(errorMessageOf(squashAtomCommandFailure(result), "Could not change the key."));
        }
      })
      .finally(() => setPending(false));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {props.mode === "renew" ? `Renew «${key.label}»` : `Edit «${key.label}»`}
          </DialogTitle>
          <DialogDescription>
            The key stays the same: whoever holds it keeps their setup. Changes apply from their
            next request.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-sm">
            {props.mode === "renew" ? (
              <>
                <label className="flex flex-col gap-1 text-xs font-medium sm:w-40">
                  Valid for days from now (1 to 366)
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
                {key.limits.total === null ? null : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Used {formatTokens(key.usage?.total ?? 0)} of {formatTokens(key.limits.total)}{" "}
                      total. Renewing does not reset it: raise the total to give more.
                    </p>
                    <CapsFields
                      caps={caps}
                      unlimited={false}
                      disabled={pending}
                      only={["total"]}
                      onCaps={setCaps}
                      onUnlimited={setUnlimited}
                    />
                  </>
                )}
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Who it is for
                  <Input
                    aria-label="Who it is for"
                    nativeInput
                    disabled={pending}
                    maxLength={80}
                    value={label}
                    onChange={(event) => setLabel(event.currentTarget.value)}
                  />
                </label>
                <CapsFields
                  caps={caps}
                  unlimited={unlimited}
                  disabled={pending}
                  onCaps={setCaps}
                  onUnlimited={setUnlimited}
                />
                <AccountPicker
                  accounts={props.accounts}
                  all={allAccounts}
                  chosen={chosen}
                  disabled={pending}
                  onAll={setAllAccounts}
                  onChosen={setChosen}
                />
                <ModelPicker
                  catalog={catalogOf(reached)}
                  all={allModels}
                  entries={entries}
                  disabled={pending}
                  onAll={setAllModels}
                  onEntries={setEntries}
                />
              </>
            )}
            {error === null ? null : (
              <span className="text-xs text-destructive" role="alert">
                {error}
              </span>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={pending || !ready} onClick={submit}>
            {props.mode === "renew" ? "Renew key" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function NewAccessKeyForm(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  /** The Space's own gateway accounts, with the models each serves. */
  readonly accounts: ReadonlyArray<AccessKeyAccountOption>;
  /** Before the accounts are read: whether the Space holds a subscription. */
  readonly spaceHasSubscription: boolean;
  /** What a key is, said once at the top of the dialog. */
  readonly description: string;
  readonly create: ReturnType<typeof useAccessKeyCommands>["create"];
  readonly onCancel: () => void;
  readonly onMade: (key: AccessKey, secret: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [allAccounts, setAllAccounts] = useState(true);
  const [chosenAccounts, setChosenAccounts] = useState<ReadonlyArray<AiAccountId>>([]);
  const reached = allAccounts
    ? props.accounts
    : props.accounts.filter((account) => chosenAccounts.includes(account.id));
  const subscription =
    props.accounts.length === 0
      ? props.spaceHasSubscription
      : reached.some((account) => account.type === "subscription");
  const [allModels, setAllModels] = useState(false);
  const [entries, setEntries] = useState<ReadonlyArray<string>>([]);
  const [caps, setCaps] = useState<Readonly<Record<keyof AccessKeyLimits, string>>>({
    total: "",
    day: "",
    week: "",
    month: "",
  });
  const [unlimited, setUnlimited] = useState(false);
  const limits = unlimited ? null : limitsOf(caps);
  // At least one cap, or «No token limit» chosen: an uncapped key is a decision, never a default.
  const capsReady =
    unlimited || (limits !== null && CAP_LABELS.some(([kind]) => limits[kind] !== null));
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
  const models: ReadonlyArray<string> = allModels ? ["*"] : entries;
  const ready =
    label.trim().length > 0 &&
    validity !== null &&
    models.length > 0 &&
    capsReady &&
    (allAccounts || chosenAccounts.length > 0);
  return (
    <form
      aria-label="Create an access key"
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (validity === null) return;
        setPending(true);
        setError(null);
        void props
          .create({
            environmentId: props.environmentId,
            input: {
              spaceId: props.spaceId,
              label: label.trim(),
              validity,
              models,
              ...(allAccounts ? {} : { accounts: chosenAccounts }),
              ...(unlimited || limits === null ? { unlimited: true } : { limits }),
            },
          })
          .then((result) => {
            if (result._tag === "Success") {
              props.onMade(result.value.created, Redacted.value(result.value.key));
            } else {
              setError(errorMessageOf(squashAtomCommandFailure(result), "Could not make the key."));
            }
          })
          .finally(() => setPending(false));
      }}
    >
      <DialogHeader>
        <DialogTitle>New access key</DialogTitle>
        <DialogDescription>{props.description}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="flex flex-col gap-1 text-xs font-medium">
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
              <div className="flex items-center gap-2">
                <ToggleGroup
                  aria-label="Valid"
                  size="sm"
                  value={[mode]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "days" || value === "until") setMode(value);
                  }}
                >
                  <Toggle value="days">For days</Toggle>
                  <Toggle value="until">Until a date</Toggle>
                </ToggleGroup>
                {mode === "days" ? (
                  <Input
                    aria-label="Days"
                    title="Days (1 to 366)"
                    className="w-20"
                    nativeInput
                    type="number"
                    min={1}
                    max={366}
                    disabled={pending}
                    value={days}
                    onChange={(event) => setDays(event.currentTarget.value)}
                  />
                ) : (
                  <Input
                    aria-label="Until"
                    title="Until the end of"
                    className="w-40"
                    nativeInput
                    type="date"
                    disabled={pending}
                    value={until}
                    onChange={(event) => setUntil(event.currentTarget.value)}
                  />
                )}
              </div>
            </div>
          </div>
          <CapsFields
            caps={caps}
            unlimited={unlimited}
            disabled={pending}
            onCaps={setCaps}
            onUnlimited={setUnlimited}
          />
          <AccountPicker
            accounts={props.accounts}
            all={allAccounts}
            chosen={chosenAccounts}
            disabled={pending}
            onAll={setAllAccounts}
            onChosen={setChosenAccounts}
          />
          {subscription ? (
            <p
              className="flex items-center gap-1 text-xs text-warning-foreground"
              role="note"
              aria-label={SUBSCRIPTION_WARNING}
            >
              Reaches a subscription: sharing it outside this Space may break the provider's terms.
              <InfoTip label="About sharing a subscription">{SUBSCRIPTION_WARNING}</InfoTip>
            </p>
          ) : null}
          <ModelPicker
            catalog={catalogOf(reached)}
            all={allModels}
            entries={entries}
            disabled={pending}
            onAll={setAllModels}
            onEntries={setEntries}
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        {error === null ? null : (
          <span className="me-auto self-center text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
        <Button variant="outline" type="button" disabled={pending} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button disabled={pending || !ready} type="submit">
          Create key
        </Button>
      </DialogFooter>
    </form>
  );
}

import { AI_ACCOUNT_STATUS_LABELS, quotaText } from "@t3tools/client-runtime/ai-accounts-view";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AI_CLIPROXY_IMPORT_MAX_FILES, sameResourceOwner } from "@t3tools/contracts";
import type {
  AiAccountDetails,
  AiAccountOwnerOption,
  AiAccountImportCliproxyFileResult,
  AiAccountProvider,
  AiAccountLoginStartResult,
  AiAccountSummary,
  AiAccountUpdateInput,
  AiApiKeyProvider,
  AiDirectProvider,
  AiSubscriptionProvider,
  EnvironmentId,
  ResourceOwner,
  SpaceId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  EllipsisIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useCurrentSpace } from "../../state/currentSpace";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AccessKeysSection } from "./AccessKeysSettings";
import { AiUsageTab } from "./AiUsageSettings";
import { InfoTip } from "./InfoTip";
import { LendAiAccountDialog } from "./LendAiAccountDialog";
import { MigratedLoansReview } from "./MigratedLoansReview";
import { LocalCliKeysSection } from "./LocalCliKeysSettings";
import type { OwnedResourceScope } from "./ownedResourceScope";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** Hidden as typed, and no password manager prompt: it is not a login. */
const KEY_INPUT_PROPS = {
  type: "text",
  className: "[-webkit-text-security:disc]",
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
} as const;

const API_KEY_PROVIDERS: ReadonlyArray<readonly [AiApiKeyProvider, string]> = [
  ["claude", "Anthropic (Claude)"],
  ["codex", "OpenAI (Codex)"],
  ["gemini", "Gemini"],
  ["vertex", "Vertex AI"],
  ["xai", "xAI"],
  ["meta", "Meta"],
  ["openai-compatible", "OpenAI-compatible (DeepSeek, OpenRouter…)"],
];
/** Subscriptions the Owner signs in to through the Hub's AI gateway (spec 4 ticket 03). */
const SUBSCRIPTION_PROVIDERS: ReadonlyArray<readonly [AiSubscriptionProvider, string]> = [
  ["claude", "Claude (Pro or Max)"],
  ["codex", "ChatGPT (Codex)"],
  ["antigravity", "Google (Antigravity: AI Pro or Ultra)"],
  ["kimi", "Kimi"],
  ["xai", "xAI (Grok)"],
  ["devin", "Devin"],
  ["meta", "Meta"],
];
/**
 * Spec 4 ticket 07: API keys handed to an agent whose CLI takes no base URL (the agent it is for
 * in brackets). Never a subscription login.
 */
const DIRECT_PROVIDERS: ReadonlyArray<readonly [AiDirectProvider, string]> = [
  ["gemini", "Gemini API key (Antigravity)"],
  ["vertex", "Vertex AI express key (Antigravity)"],
  ["cursor", "Cursor API key (Cursor)"],
  ["kiro", "Kiro API key (Kiro)"],
  ["fx", "Vercel AI Gateway key (Fx)"],
  ["meta", "Meta API key (Muse)"],
  ["devin", "Devin token (Devin, ACP Registry)"],
  ["xai", "xAI API key (Grok)"],
];
/** The direct credential's warning: it enters the agent's process, and so its Sandbox. */
const DIRECT_WARNING =
  "This credential will be visible to the agent: it enters the agent's process, and anything the agent runs can read it. Use a revocable API key or token, never a subscription login.";
const providerLabel = (provider: AiAccountProvider, type?: AiAccountSummary["type"]) =>
  (type === "subscription"
    ? (SUBSCRIPTION_PROVIDERS.find(([value]) => value === provider)?.[1] ??
      (provider === "vertex" ? "Vertex AI (service account)" : undefined))
    : type === "direct"
      ? DIRECT_PROVIDERS.find(([value]) => value === provider)?.[1]
      : undefined) ??
  API_KEY_PROVIDERS.find(([value]) => value === provider)?.[1] ??
  provider;

/** ADR 0005: the Owner shares a personal subscription knowingly. */
const TOS_WARNING =
  "Sharing a personal subscription with your team may break the provider's terms; the provider may suspend the account. API keys and per-seat plans are the compliant choice.";
/** A User's own subscription is used only in their Personal space: nothing is shared. */
const PERSONAL_TOS_NOTE =
  "Only your own Threads in your Personal space use it. The Hub signs in from its own address, which the provider may see as a datacenter's; check its terms allow that.";
/** The warning a subscription gets: shared with others (the Owner's, an Organization's) or not. */
const tosOf = (shared: boolean) => (shared ? TOS_WARNING : PERSONAL_TOS_NOTE);
const ANTIGRAVITY_NOTE =
  "CLIProxyAPI disguises its Antigravity traffic (hardened in v8.0.65), a sign that Google detects and may suspend this use.";

const splitModels = (text: string) =>
  text
    .split(/[\s,]+/u)
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

async function settle<A, E>(pending: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Success") return result.value;
  throw new Error(errorMessageOf(squashAtomCommandFailure(result), "That did not work."));
}

function useAccountCommands() {
  return {
    list: useAtomCommand(aiGatewayEnvironment.listAccounts, "list the AI accounts"),
    create: useAtomCommand(aiGatewayEnvironment.createAccount, "add an AI account"),
    update: useAtomCommand(aiGatewayEnvironment.updateAccount, "change an AI account"),
    remove: useAtomCommand(aiGatewayEnvironment.deleteAccount, "delete an AI account"),
    reorder: useAtomCommand(aiGatewayEnvironment.reorderAccounts, "order the AI accounts"),
    loginStart: useAtomCommand(aiGatewayEnvironment.startAccountLogin, "start a sign-in"),
    loginComplete: useAtomCommand(aiGatewayEnvironment.completeAccountLogin, "finish a sign-in"),
    importVertex: useAtomCommand(
      aiGatewayEnvironment.importVertexAccount,
      "import a Vertex service account",
    ),
    importCliproxy: useAtomCommand(
      aiGatewayEnvironment.importCliproxyAccounts,
      "import CLIProxyAPI sign-ins",
    ),
  };
}
type AccountCommands = ReturnType<typeof useAccountCommands>;

/**
 * Settings → AI accounts: each User's own («Mine») and their Organizations', to add, order, change,
 * lend and delete; the Owner also reviews the loans the upgrade narrowed. Others' only by name,
 * provider and status. A key is never shown again once saved, only replaced.
 */
export function AiAccountsSettingsPanel({
  scope,
  after,
}: {
  readonly scope?: OwnedResourceScope;
  /** Shown below the accounts (a Space's access keys, in Space settings). */
  readonly after?: ReactNode;
}) {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : (
        <AiAccountsPage environmentId={environmentId} scope={scope} />
      )}
      {after}
    </SettingsPageContainer>
  );
}

interface Subject {
  readonly id: string;
  readonly name: string;
}

function AiAccountsPage({
  environmentId,
  scope,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: OwnedResourceScope | undefined;
}) {
  const commands = useAccountCommands();
  const spaceView = useCurrentSpace((state) => state.view);
  // The session may change the Hub's settings at all (settings:write); the Hub decides the rest.
  const mayWrite = useAtomValue(aiGatewayEnvironment.createAccount.permissionAtom(environmentId));
  const [accounts, setAccounts] = useState<ReadonlyArray<AiAccountSummary> | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [owners, setOwners] = useState<ReadonlyArray<AiAccountOwnerOption>>([]);
  const [error, setError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [tab, setTab] = useState<AiAccountsTab>("accounts");
  const [importing, setImporting] = useState(false);
  const manage = mayWrite;
  // An Organization's section lists only its AI accounts: no keys, usage or what is only usable.
  const organizationScope = scope?.kind === "organization" ? scope : null;
  const inScope = (option: AiAccountOwnerOption, mine: boolean) =>
    scope === undefined ||
    (scope.kind === "user"
      ? mine
      : option.owner.kind === "organization" && option.owner.spaceId === scope.spaceId);

  const loadAccounts = useEffectEvent((target: EnvironmentId) =>
    settle(commands.list({ environmentId: target, input: {} })),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the AI accounts the signed-in User may see from the Hub when the page opens.
  useEffect(() => {
    let cancelled = false;
    void loadAccounts(environmentId).then(
      (listed) => {
        if (cancelled) return;
        setAccounts(listed.accounts);
        setCanManage(listed.canManage);
        setOwners(listed.owners ?? []);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessageOf(cause, "Could not read the AI accounts."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const refresh = async () => {
    try {
      const listed = await settle(commands.list({ environmentId, input: {} }));
      setAccounts(listed.accounts);
      setCanManage(listed.canManage);
      setOwners(listed.owners ?? []);
      setError(null);
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not read the AI accounts."));
    }
  };

  const spaces: ReadonlyArray<Subject> = (spaceView?.spaces ?? []).map((space) => ({
    id: space.id,
    name: space.kind === "personal" ? `${space.name} (personal)` : space.name,
  }));
  const spaceName = (spaceId: SpaceId) =>
    spaces.find((space) => space.id === spaceId)?.name ?? spaceId;

  /** Whether the account is this owner's. */
  const ownedBy = (account: AiAccountSummary, owner: ResourceOwner) =>
    account.owner !== undefined && sameResourceOwner(account.owner, owner);
  /** An owner's accounts the viewer manages, by their order. */
  const accountsOf = (owner: ResourceOwner) =>
    (accounts ?? []).filter((account) => account.canManage === true && ownedBy(account, owner));
  // The viewer's own subscriptions are theirs alone, unless they are the Owner (Lend… warns anyway).
  const sharedFor = (owner: ResourceOwner) => owner.kind === "organization" || canManage;

  /** One move at a time, within one owner's order, from what the Hub last answered. */
  const move = async (account: AiAccountSummary, by: -1 | 1) => {
    if (accounts === null || reordering || account.owner === undefined) return;
    const owner = account.owner;
    const accountId = account.id;
    const order = accountsOf(owner)
      .filter((entry) => entry.status !== "removing")
      .map((entry) => entry.id);
    const index = order.indexOf(accountId);
    if (index < 0 || index + by < 0 || index + by >= order.length) return;
    order.splice(index, 1);
    order.splice(index + by, 0, accountId);
    setReordering(true);
    try {
      const listed = await settle(
        commands.reorder({ environmentId, input: { accountIds: order, owner } }),
      );
      setAccounts(listed.accounts);
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not change the order."));
      await refresh();
    } finally {
      setReordering(false);
    }
  };

  const ordered = (accounts ?? []).filter((account) => account.status !== "removing");
  // Everyone's own keys for local CLIs (spec 4 ticket 10).
  if (organizationScope === null && tab === "keys") {
    return (
      <>
        <AiAccountsTabs tab={tab} onTab={setTab} usage={canManage} />
        <LocalCliKeysSection environmentId={environmentId} />
      </>
    );
  }
  // The Owner's tab: every Space's access keys, to see and revoke (access-keys ticket 07).
  if (organizationScope === null && canManage && tab === "access-keys") {
    return (
      <>
        <AiAccountsTabs tab={tab} onTab={setTab} usage={canManage} />
        <AccessKeysSection />
      </>
    );
  }
  // The Owner's tab: what went through the AI gateway (spec 4 ticket 05).
  if (organizationScope === null && canManage && tab === "usage") {
    return (
      <>
        <AiAccountsTabs tab={tab} onTab={setTab} usage={canManage} />
        <AiUsageTab
          environmentId={environmentId}
          directAccounts={ordered
            .filter((account) => account.type === "direct")
            .map((account) => account.name)}
        />
      </>
    );
  }
  // Accounts the viewer may use but not manage, and (for the Owner) everyone else's.
  const usable = (accounts ?? []).filter(
    (account) => account.canManage !== true && account.usableIn.length > 0,
  );
  const others = (accounts ?? []).filter(
    (account) => account.canManage !== true && account.usableIn.length === 0,
  );
  const accountItem = (account: AiAccountSummary, ownerOrder: ReadonlyArray<AiAccountSummary>) => {
    const live = ownerOrder.filter((entry) => entry.status !== "removing");
    return (
      <AccountRow
        key={account.id}
        environmentId={environmentId}
        commands={commands}
        account={account}
        canManage={manage && account.canManage === true}
        shared={account.owner === undefined ? true : sharedFor(account.owner)}
        spaceName={spaceName}
        first={live[0]?.id === account.id}
        last={live.at(-1)?.id === account.id}
        reordering={reordering}
        onMove={(by) => move(account, by)}
        onChanged={refresh}
      />
    );
  };
  return (
    <>
      {organizationScope === null ? (
        <AiAccountsTabs tab={tab} onTab={setTab} usage={canManage} />
      ) : null}
      {/* What AI accounts are, in one line; the rest on demand. */}
      <section
        id="ai-accounts"
        aria-label="AI accounts"
        className="flex flex-col gap-1.5 px-3 sm:px-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="max-w-2xl text-sm text-muted-foreground">
            API keys and subscriptions your agents use through the Hub's AI gateway, tried first to
            last.
          </p>
          {manage && canManage && organizationScope === null ? (
            <Button size="xs" variant="outline" onClick={() => setImporting(true)}>
              <UploadIcon />
              Import from CLIProxyAPI…
            </Button>
          ) : null}
        </div>
        <Collapsible>
          <CollapsibleTrigger className="flex w-fit items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon aria-hidden className="size-3 [[data-panel-open]_&]:rotate-90" />
            How this works
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <p className="max-w-2xl pt-1 text-xs text-muted-foreground">
              Yours are used only in your Personal space; an Organization's by whoever works there.
              A credential never leaves the Hub and is never shown again: replace it, or sign in
              again, to change it.
            </p>
          </CollapsiblePanel>
        </Collapsible>
        {error === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </section>
      {importing ? (
        <ImportCliproxyDialog
          environmentId={environmentId}
          commands={commands}
          onAdded={refresh}
          onClose={() => setImporting(false)}
        />
      ) : null}
      {/* Grants ticket 02: what the upgrade narrowed, until the Owner lends or dismisses each. */}
      {canManage && organizationScope === null ? (
        <MigratedLoansReview environmentId={environmentId} />
      ) : null}
      {owners
        .filter((option) => inScope(option, option === owners[0] && option.owner.kind === "user"))
        .map((option) => (
          <AiAccountOwnerSection
            key={option.owner.kind === "user" ? option.owner.userId : option.owner.spaceId}
            environmentId={environmentId}
            commands={commands}
            option={option}
            mine={option === owners[0] && option.owner.kind === "user"}
            manage={manage}
            shared={sharedFor(option.owner)}
            onAdded={refresh}
          >
            {accounts === null ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
            ) : accountsOf(option.owner).length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">No AI account yet.</p>
            ) : (
              <ul
                aria-label={`AI accounts of ${option.name}`}
                className="divide-y divide-border/50"
              >
                {accountsOf(option.owner).map((account) =>
                  accountItem(account, accountsOf(option.owner)),
                )}
              </ul>
            )}
          </AiAccountOwnerSection>
        ))}
      {organizationScope !== null || usable.length === 0 ? null : (
        <SettingsSection id="ai-accounts-usable" title="AI accounts you may use">
          <ul aria-label="AI accounts you may use" className="divide-y divide-border/50">
            {usable.map((account) => accountItem(account, usable))}
          </ul>
        </SettingsSection>
      )}
      {organizationScope !== null || others.length === 0 ? null : (
        <SettingsSection
          id="ai-accounts-others"
          title="Other people's AI accounts"
          titleAction={
            <InfoTip label="About other people's AI accounts">
              Name, provider, owner and status only: each person and Organization manages their own;
              you see that they exist.
            </InfoTip>
          }
        >
          <ul aria-label="Other people's AI accounts" className="divide-y divide-border/50">
            {others.map((account) => accountItem(account, others))}
          </ul>
        </SettingsSection>
      )}
    </>
  );
}

/**
 * One owner's AI accounts (owned-resources 08, 09): «Mine», or an Organization the viewer runs,
 * with what adds one for that owner. Takes the owner, so the settings modals can move it whole.
 */
function AiAccountOwnerSection(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly option: AiAccountOwnerOption;
  readonly mine: boolean;
  readonly manage: boolean;
  readonly shared: boolean;
  readonly onAdded: () => Promise<void>;
  readonly children: ReactNode;
}) {
  const { option } = props;
  const [adding, setAdding] = useState(false);
  const id = option.owner.kind === "user" ? "mine" : option.owner.spaceId;
  const description = props.mine
    ? "Used only by your own Threads in your Personal space; nobody else sees or uses them without a loan."
    : `Used by everyone who works in ${option.name}. Its Admins add and change them.`;
  return (
    <SettingsSection
      id={`ai-accounts-owner-${id}`}
      title={props.mine ? "Mine" : option.name}
      titleAction={
        <InfoTip
          label={props.mine ? "About your own AI accounts" : `About ${option.name}'s AI accounts`}
        >
          {description}
        </InfoTip>
      }
      headerAction={
        props.manage ? (
          <Button
            size="xs"
            aria-label={`Add AI account to ${props.mine ? "Mine" : option.name}`}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add AI account
          </Button>
        ) : null
      }
    >
      {props.children}
      {adding ? (
        <AddAiAccountDialog
          environmentId={props.environmentId}
          commands={props.commands}
          owner={option.owner}
          title={props.mine ? "Add one of your AI accounts" : `Add an AI account to ${option.name}`}
          description={description}
          shared={props.shared}
          onAdded={props.onAdded}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </SettingsSection>
  );
}

type NewAccountKind = "api-key" | "subscription" | "vertex";

/** «Add AI account»: an API key (or direct credential), a subscription, or a Vertex account. */
function AddAiAccountDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly owner: ResourceOwner;
  readonly title: string;
  readonly description: string;
  readonly shared: boolean;
  readonly onAdded: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const [kind, setKind] = useState<NewAccountKind>("api-key");
  const added = async () => {
    await props.onAdded();
    props.onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <ToggleGroup
              aria-label="Kind of AI account"
              size="sm"
              value={[kind]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "api-key" || value === "subscription" || value === "vertex") {
                  setKind(value);
                }
              }}
            >
              <Toggle value="api-key">API key</Toggle>
              <Toggle value="subscription">Subscription</Toggle>
              <Toggle value="vertex">Vertex service account</Toggle>
            </ToggleGroup>
            {kind === "api-key" ? (
              <NewAccountForm
                environmentId={props.environmentId}
                commands={props.commands}
                owner={props.owner}
                onAdded={added}
              />
            ) : kind === "subscription" ? (
              <NewSubscriptionForm
                environmentId={props.environmentId}
                commands={props.commands}
                owner={props.owner}
                shared={props.shared}
                onAdded={added}
              />
            ) : (
              <ImportVertexForm
                environmentId={props.environmentId}
                commands={props.commands}
                owner={props.owner}
                onAdded={added}
              />
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

type AiAccountsTab = "accounts" | "keys" | "usage" | "access-keys";

function AiAccountsTabs(props: {
  readonly tab: AiAccountsTab;
  readonly onTab: (tab: AiAccountsTab) => void;
  /** The Owner's Usage tab. */
  readonly usage: boolean;
}) {
  return (
    <ToggleGroup
      aria-label="AI accounts sections"
      value={[props.tab]}
      onValueChange={(next) => {
        const value = next[0];
        if (
          value === "accounts" ||
          value === "keys" ||
          ((value === "usage" || value === "access-keys") && props.usage)
        ) {
          props.onTab(value);
        }
      }}
    >
      <Toggle value="accounts">Accounts</Toggle>
      <Toggle value="keys">Local CLI keys</Toggle>
      {props.usage ? <Toggle value="usage">Usage</Toggle> : null}
      {/* The Owner's view of every Space's access keys (access-keys ticket 07). */}
      {props.usage ? <Toggle value="access-keys">Access keys</Toggle> : null}
    </ToggleGroup>
  );
}

function NewAccountForm(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly owner: ResourceOwner;
  readonly onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"api-key" | "direct">("api-key");
  const [provider, setProvider] = useState<AiApiKeyProvider | AiDirectProvider>("claude");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const direct = kind === "direct";
  const compatible = !direct && provider === "openai-compatible";
  const providerItems = (direct ? DIRECT_PROVIDERS : API_KEY_PROVIDERS).map(([value, label]) => ({
    value,
    label,
  }));
  const kindItems = [
    { value: "api-key", label: "Through the AI gateway" },
    { value: "direct", label: "Direct credential" },
  ];
  const modelList = splitModels(models);
  const ready =
    name.trim().length > 0 &&
    apiKey.trim().length > 0 &&
    (!compatible || (baseUrl.trim().length > 0 && modelList.length > 0));
  return (
    <form
      aria-label="Add an API key"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void settle(
          props.commands.create({
            environmentId: props.environmentId,
            input: {
              name: name.trim(),
              ...(direct ? { type: "direct" as const } : {}),
              provider,
              apiKey: Redacted.make(apiKey.trim()),
              ...(compatible ? { baseUrl: baseUrl.trim(), models: modelList } : {}),
              owner: props.owner,
            },
          }),
        )
          .then(async () => {
            setName("");
            setApiKey("");
            setBaseUrl("");
            setModels("");
            await props.onAdded();
          })
          .catch((cause: unknown) => setError(errorMessageOf(cause, "Could not add it.")))
          .finally(() => setPending(false));
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
          AI account name
          <Input
            aria-label="AI account name"
            nativeInput
            disabled={pending}
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Credential type
          <Select
            disabled={pending}
            items={kindItems}
            value={kind}
            onValueChange={(value) => {
              if (value !== "api-key" && value !== "direct") return;
              setKind(value);
              setProvider(value === "direct" ? "gemini" : "claude");
            }}
          >
            <SelectTrigger aria-label="Credential type">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {kindItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Provider
          <Select
            disabled={pending}
            items={providerItems}
            value={provider}
            onValueChange={(value) => {
              if (value !== null) setProvider(value as AiApiKeyProvider | AiDirectProvider);
            }}
          >
            <SelectTrigger aria-label="Provider">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {providerItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        API key
        <Input
          aria-label="API key"
          nativeInput
          disabled={pending}
          value={apiKey}
          onChange={(event) => setApiKey(event.currentTarget.value)}
          {...KEY_INPUT_PROPS}
        />
      </label>
      {direct ? (
        <p className="text-xs text-warning-foreground" role="note">
          {DIRECT_WARNING}
        </p>
      ) : null}
      {compatible ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Base URL
            <Input
              aria-label="Base URL"
              nativeInput
              disabled={pending}
              placeholder="https://openrouter.ai/api/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Models
            <Input
              aria-label="Models"
              nativeInput
              disabled={pending}
              placeholder="deepseek-chat, deepseek-reasoner"
              value={models}
              onChange={(event) => setModels(event.currentTarget.value)}
            />
          </label>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button disabled={pending || !ready} size="sm" type="submit">
          Add AI account
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

/**
 * The Owner signs in on the provider's page in their own browser. The provider sends the browser
 * back to a localhost address that does not open (the Hub may be on a VPS): the Owner pastes that
 * address here, and the Hub hands it to its CLIProxyAPI. Device sign-ins show a code instead.
 */
function SignInFlow(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly label: string;
  readonly provider: AiSubscriptionProvider;
  readonly target:
    | { readonly name: string; readonly owner: ResourceOwner }
    | { readonly accountId: AiAccountSummary["id"] };
  readonly disabled: boolean;
  readonly onDone: () => Promise<void>;
}) {
  const [started, setStarted] = useState<AiAccountLoginStartResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [landed, setLanded] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setPending(true);
    setError(null);
    setLanded("");
    void settle(
      props.commands.loginStart({
        environmentId: props.environmentId,
        input: { provider: props.provider, ...props.target },
      }),
    )
      .then(setStarted)
      .catch((cause: unknown) => setError(errorMessageOf(cause, "Could not start the sign-in.")))
      .finally(() => setPending(false));
  };
  const finish = (confirmIdentity?: boolean) => {
    if (started === null) return;
    setPending(true);
    setError(null);
    setNotice(null);
    setMismatch(false);
    void settle(
      props.commands.loginComplete({
        environmentId: props.environmentId,
        input: {
          loginId: started.loginId,
          ...(started.flow === "redirect" ? { redirectUrl: Redacted.make(landed.trim()) } : {}),
          ...(confirmIdentity === true ? { confirmIdentity } : {}),
        },
      }),
    )
      .then(async (account) => {
        setStarted(null);
        setLanded("");
        // A new subscription waits, off, until the Owner checks who it signed in as.
        if (account.disabled) setNotice(account.statusMessage);
        await props.onDone();
      })
      .catch((cause: unknown) => {
        const message = errorMessageOf(cause, "Could not finish the sign-in.");
        // «Sign in again» as another account: the Owner says whether to use it.
        setMismatch(/Confirm to use it/u.test(message));
        setError(message);
      })
      .finally(() => setPending(false));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={started === null ? "default" : "outline"}
          type="button"
          disabled={props.disabled || pending}
          onClick={start}
        >
          {started === null ? props.label : "Start over"}
        </Button>
        {started === null ? null : (
          <a
            className="text-sm font-medium underline"
            href={started.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open sign-in
          </a>
        )}
      </div>
      {started === null ? null : started.flow === "device" ? (
        <div className="flex flex-col gap-2 text-sm">
          <span>
            On the provider's page, enter the code{" "}
            <code aria-label="Sign-in code">{started.userCode}</code>, then come back.
          </span>
          <div>
            <Button size="sm" type="button" disabled={pending} onClick={() => finish()}>
              I have signed in
            </Button>
          </div>
        </div>
      ) : (
        <form
          aria-label="Finish the sign-in"
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            finish();
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Paste the address you landed on
            <Input
              aria-label="Paste the address you landed on"
              nativeInput
              disabled={pending}
              placeholder="http://localhost:…/callback?code=…&state=…"
              value={landed}
              onChange={(event) => setLanded(event.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Button size="sm" type="submit" disabled={pending || landed.trim().length === 0}>
            Finish sign-in
          </Button>
        </form>
      )}
      {started === null ? null : (
        <span className="text-xs text-muted-foreground">
          {started.flow === "device"
            ? "This sign-in lasts 10 minutes."
            : "After you sign in, the browser lands on a localhost address that does not open. Copy that whole address from the address bar and paste it here. This sign-in lasts 10 minutes."}
        </span>
      )}
      {error === null ? null : (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
      {mismatch ? (
        <div>
          <Button
            size="sm"
            variant="destructive"
            type="button"
            disabled={pending}
            onClick={() => finish(true)}
          >
            Use the new account
          </Button>
        </div>
      ) : null}
      {notice === null ? null : (
        <span className="text-xs" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}

/** «Add subscription»: a name, the provider, the ToS warning, then the sign-in. */
function NewSubscriptionForm(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly owner: ResourceOwner;
  /** Others use it (the Owner's, an Organization's): the sharing warning; else a User's own. */
  readonly shared: boolean;
  readonly onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AiSubscriptionProvider>("claude");
  const subscriptionItems = SUBSCRIPTION_PROVIDERS.map(([value, label]) => ({ value, label }));
  return (
    <section aria-label="Add subscription" className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
          Subscription name
          <Input
            aria-label="Subscription name"
            nativeInput
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-72">
          Subscription provider
          <Select
            items={subscriptionItems}
            value={provider}
            onValueChange={(value) => {
              if (value !== null) setProvider(value as AiSubscriptionProvider);
            }}
          >
            <SelectTrigger aria-label="Subscription provider">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {subscriptionItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
      </div>
      <p
        role="note"
        aria-label="Terms of service warning"
        className="text-xs text-warning-foreground"
      >
        {tosOf(props.shared)}
        {provider === "antigravity" ? ` ${ANTIGRAVITY_NOTE}` : ""}
      </p>
      <SignInFlow
        key={`${provider}|${name.trim()}`}
        environmentId={props.environmentId}
        commands={props.commands}
        label="Start sign-in"
        provider={provider}
        target={{ name: name.trim(), owner: props.owner }}
        disabled={name.trim().length === 0}
        onDone={async () => {
          setName("");
          await props.onAdded();
        }}
      />
    </section>
  );
}

/** A Vertex service account (its JSON key file), imported into the gateway. */
function ImportVertexForm(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly owner: ResourceOwner;
  readonly onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label="Import a Vertex service account"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void settle(
          props.commands.importVertex({
            environmentId: props.environmentId,
            input: {
              name: name.trim(),
              serviceAccount: Redacted.make(key.trim()),
              owner: props.owner,
            },
          }),
        )
          .then(async () => {
            setName("");
            setKey("");
            await props.onAdded();
          })
          .catch((cause: unknown) => setError(errorMessageOf(cause, "Could not import it.")))
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-col gap-1 text-xs font-medium">
        Vertex account name
        <Input
          aria-label="Vertex account name"
          nativeInput
          disabled={pending}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Service account key (JSON)
        <textarea
          aria-label="Service account key (JSON)"
          className="min-h-20 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs [-webkit-text-security:disc]"
          disabled={pending}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={pending || name.trim().length === 0 || key.trim().length === 0}
        >
          Import
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

/** The rule an imported sign-in lives by: its refresh token works in one proxy at a time. */
const ONE_PROXY_NOTE =
  "Stop the old CLIProxyAPI (or delete its copies of these files) once imported: a sign-in's refresh token works in one proxy only, and a refresh on either side signs the other out.";

/**
 * Spec 4 ticket 15: another CLIProxyAPI's auth files (Claude, Codex, Antigravity), each a
 * subscription, disabled until the Owner checks who it is signed in as.
 */
function ImportCliproxyDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly onAdded: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ReadonlyArray<AiAccountImportCliproxyFileResult>>([]);
  const importFiles = async (picked: ReadonlyArray<File>) => {
    if (picked.length > AI_CLIPROXY_IMPORT_MAX_FILES) {
      setError(`Pick at most ${AI_CLIPROXY_IMPORT_MAX_FILES} files at a time.`);
      return;
    }
    setPending(true);
    setError(null);
    setResults([]);
    try {
      const files = await Promise.all(
        picked.map(async (file) => ({
          fileName: file.name,
          contents: Redacted.make(await file.text()),
        })),
      );
      const answer = await settle(
        props.commands.importCliproxy({ environmentId: props.environmentId, input: { files } }),
      );
      setResults(answer.files);
      await props.onAdded();
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not import them."));
    } finally {
      setPending(false);
    }
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
          <DialogTitle>Import from CLIProxyAPI</DialogTitle>
          <DialogDescription>
            Pick the auth files of another CLIProxyAPI (its auth folder: claude-…, codex-…,
            antigravity-….json). Each becomes a subscription, off until you check who it is signed
            in as.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <section aria-label="Import from CLIProxyAPI" className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{ONE_PROXY_NOTE}</p>
            <p className="text-xs text-warning-foreground" role="note">
              {TOS_WARNING}
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              aria-label="CLIProxyAPI auth files"
              onChange={(event) => {
                const picked = Array.from(event.currentTarget.files ?? []);
                // The same files can be picked again.
                event.currentTarget.value = "";
                if (picked.length > 0) void importFiles(picked);
              }}
            />
            {error === null ? null : (
              <span className="text-xs text-destructive" role="alert">
                {error}
              </span>
            )}
            {results.length === 0 ? null : (
              <ul aria-label="Imported files" className="flex flex-col gap-1 text-xs">
                {results.map((result) => (
                  <li key={`${result.fileName}:${result.accountId ?? result.reason ?? ""}`}>
                    <span className="font-mono">{result.fileName}</span>
                    {": "}
                    {result.outcome === "imported"
                      ? `imported as «${result.name}», off until you turn it on.`
                      : `skipped. ${result.reason ?? ""}`}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={props.onClose}>
            {results.length === 0 ? "Cancel" : "Done"}
          </Button>
          <Button type="button" disabled={pending} onClick={() => inputRef.current?.click()}>
            Choose CLIProxyAPI auth files
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const KIND_LABELS: Readonly<Record<AiAccountSummary["type"], string>> = {
  subscription: "Subscription",
  "api-key": "API key",
  direct: "Direct",
};

/** A status in a colour: working, needing attention, or broken. */
const statusVariant = (status: AiAccountSummary["status"]) =>
  status === "working"
    ? ("success" as const)
    : status === "error" || status === "removing"
      ? ("error" as const)
      : status === "disabled"
        ? ("secondary" as const)
        : ("warning" as const);

/**
 * One AI account as one dense row: its name, kind and status; its provider, priority, key hint
 * or sign-in and quota in one muted line; what it last said under it. Whoever manages it orders
 * it in place and finds the rest in its «⋯» menu; changing it opens «Manage…».
 */
function AccountRow(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly account: AiAccountSummary;
  readonly canManage: boolean;
  /** A subscription others use: the sharing warning. */
  readonly shared: boolean;
  readonly spaceName: (spaceId: SpaceId) => string;
  readonly first: boolean;
  readonly last: boolean;
  readonly reordering: boolean;
  readonly onMove: (by: -1 | 1) => Promise<void>;
  readonly onChanged: () => Promise<void>;
}) {
  const { account, commands, environmentId } = props;
  const details = account.details;
  const removing = account.status === "removing";
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lending, setLending] = useState(false);
  const [managing, setManaging] = useState(false);

  /** Runs a change; whatever it answered, the list is read again (a key may be still live). */
  const act = async (work: () => Promise<string | null>) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      return true;
    } catch (cause) {
      setError(errorMessageOf(cause, "That did not work."));
      return false;
    } finally {
      setPending(false);
      await props.onChanged();
    }
  };
  const update = (input: Omit<AiAccountUpdateInput, "accountId">) =>
    act(() =>
      settle(commands.update({ environmentId, input: { accountId: account.id, ...input } })).then(
        () => null,
      ),
    );
  const remove = () =>
    act(() =>
      settle(commands.remove({ environmentId, input: { accountId: account.id } })).then((result) =>
        result.gateway === "not-running"
          ? "Deleted. The AI gateway is not running, so its key was live nowhere."
          : null,
      ),
    );

  const meta =
    details === null
      ? [
          providerLabel(account.provider, account.type),
          account.usableIn.length > 0
            ? `Usable in ${account.usableIn.map(props.spaceName).join(", ")}`
            : account.owner?.kind === "organization"
              ? `${props.spaceName(account.owner.spaceId)}'s`
              : "Another User's own",
        ]
      : [
          providerLabel(account.provider, account.type),
          removing ? null : `Priority ${account.priority}`,
          details.keyHint === null ? null : `Key ending in …${details.keyHint}`,
          details.signedInAs === undefined || details.signedInAs === null
            ? null
            : `Signed in as ${details.signedInAs}`,
          quotaText(details)?.replace(/\.$/u, "") ?? null,
          details.baseUrl === null ? null : `${details.baseUrl} (${details.models.join(", ")})`,
        ];
  const said =
    error !== null ? (
      <span className="text-destructive" role="alert">
        {error}
      </span>
    ) : notice !== null ? (
      <span role="status">{notice}</span>
    ) : account.statusMessage === null ? null : (
      <span>{account.statusMessage}</span>
    );
  const manages = props.canManage && details !== null;
  return (
    <li
      aria-label={account.name}
      className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium">{account.name}</span>
          <Badge variant="outline" size="sm">
            {KIND_LABELS[account.type]}
          </Badge>
          <Badge
            aria-label={`Status of ${account.name}`}
            variant={statusVariant(account.status)}
            size="sm"
          >
            {AI_ACCOUNT_STATUS_LABELS[account.status]}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {meta.filter((part) => part !== null).join(" · ")}
        </p>
        {said === null ? null : <p className="text-xs text-muted-foreground">{said}</p>}
      </div>
      {!manages ? null : removing ? (
        <Button
          size="xs"
          variant="destructive"
          disabled={pending}
          aria-label={`Confirm delete ${account.name}`}
          onClick={() => void remove()}
        >
          Try removing it again
        </Button>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {account.disabled ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              aria-label={`Enable ${account.name}`}
              onClick={() => void update({ disabled: false })}
            >
              Enable
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={pending || props.reordering || props.first}
            aria-label={`Move ${account.name} up`}
            onClick={() => void props.onMove(-1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={pending || props.reordering || props.last}
            aria-label={`Move ${account.name} down`}
            onClick={() => void props.onMove(1)}
          >
            <ArrowDownIcon />
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={`Actions for ${account.name}`}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end" sideOffset={6}>
              <MenuItem aria-label={`Manage ${account.name}`} onClick={() => setManaging(true)}>
                Manage…
              </MenuItem>
              {account.disabled ? null : (
                <MenuItem
                  aria-label={`Disable ${account.name}`}
                  disabled={pending}
                  onClick={() => void update({ disabled: true })}
                >
                  Disable
                </MenuItem>
              )}
              {/* Grants 01: lent for the gateway only; a direct one's credential never leaves. */}
              {account.type === "direct" ? null : (
                <MenuItem aria-label={`Lend ${account.name}`} onClick={() => setLending(true)}>
                  Lend…
                </MenuItem>
              )}
              <MenuItem
                aria-label={`Delete ${account.name}`}
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      )}
      {managing && manages && !removing ? (
        <ManageAccountDialog
          environmentId={environmentId}
          commands={commands}
          account={account}
          details={details}
          shared={props.shared}
          pending={pending}
          said={said}
          onUpdate={update}
          onChanged={props.onChanged}
          onClose={() => setManaging(false)}
        />
      ) : null}
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmDelete(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete «{account.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone: to use it again, add it again.
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
              disabled={pending}
              aria-label={`Confirm delete ${account.name}`}
              onClick={() => void remove().then(() => setConfirmDelete(false))}
            >
              Delete for good
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {lending ? <LendAiAccountDialog account={account} onClose={() => setLending(false)} /> : null}
    </li>
  );
}

/**
 * «Manage…»: what changes an account, out of the list. Its name (an OpenAI-compatible one's base
 * URL and models too), «Sign in again» for a subscription, «Replace credential» for an API key.
 */
function ManageAccountDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly account: AiAccountSummary;
  readonly details: AiAccountDetails;
  readonly shared: boolean;
  readonly pending: boolean;
  /** What the account or the last change said, as the row says it. */
  readonly said: ReactNode;
  readonly onUpdate: (input: Omit<AiAccountUpdateInput, "accountId">) => Promise<boolean>;
  readonly onChanged: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const { account, details } = props;
  const [newKey, setNewKey] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{account.name}</DialogTitle>
          <DialogDescription>
            {providerLabel(account.provider, account.type)} · {KIND_LABELS[account.type]}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-5">
            {props.said === null ? null : <p className="text-xs">{props.said}</p>}
            <EditAccountForm
              key={`${account.name}|${details.baseUrl}|${details.models.join(",")}`}
              account={account}
              details={details}
              pending={props.pending}
              onSave={props.onUpdate}
            />
            {account.type === "subscription" && account.provider !== "vertex" ? (
              <section aria-label="Sign in again" className="flex flex-col gap-2">
                <p
                  role="note"
                  aria-label="Terms of service warning"
                  className="text-xs text-warning-foreground"
                >
                  {tosOf(props.shared)}
                </p>
                <SignInFlow
                  environmentId={props.environmentId}
                  commands={props.commands}
                  label="Sign in again"
                  provider={account.provider as AiSubscriptionProvider}
                  target={{ accountId: account.id }}
                  disabled={props.pending}
                  onDone={props.onChanged}
                />
              </section>
            ) : null}
            {account.type !== "api-key" ? null : (
              <form
                aria-label={`Replace credential of ${account.name}`}
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  void props.onUpdate({ apiKey: Redacted.make(newKey.trim()) }).then((saved) => {
                    if (saved) setNewKey("");
                  });
                }}
              >
                <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
                  New API key
                  <Input
                    aria-label={`New API key for ${account.name}`}
                    nativeInput
                    disabled={props.pending}
                    value={newKey}
                    onChange={(event) => setNewKey(event.currentTarget.value)}
                    {...KEY_INPUT_PROPS}
                  />
                </label>
                <Button
                  size="sm"
                  type="submit"
                  disabled={props.pending || newKey.trim().length === 0}
                >
                  Replace credential
                </Button>
              </form>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** Its name, and for an OpenAI-compatible account its base URL and models. */
function EditAccountForm(props: {
  readonly account: AiAccountSummary;
  readonly details: AiAccountDetails;
  readonly pending: boolean;
  readonly onSave: (input: Omit<AiAccountUpdateInput, "accountId">) => Promise<boolean>;
}) {
  const { account, details } = props;
  const compatible = account.provider === "openai-compatible";
  const [name, setName] = useState(account.name);
  const [baseUrl, setBaseUrl] = useState(details.baseUrl ?? "");
  const [models, setModels] = useState(details.models.join(", "));
  const modelList = splitModels(models);
  const changed =
    name.trim() !== account.name ||
    (compatible &&
      (baseUrl.trim() !== (details.baseUrl ?? "") ||
        modelList.join(",") !== details.models.join(",")));
  return (
    <form
      aria-label={`Edit ${account.name}`}
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave({
          ...(name.trim() === account.name ? {} : { name: name.trim() }),
          ...(compatible ? { baseUrl: baseUrl.trim(), models: modelList } : {}),
        });
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Name
        <Input
          aria-label={`Name of ${account.name}`}
          nativeInput
          disabled={props.pending}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {compatible ? (
        <>
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Base URL
            <Input
              aria-label={`Base URL of ${account.name}`}
              nativeInput
              disabled={props.pending}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Models
            <Input
              aria-label={`Models of ${account.name}`}
              nativeInput
              disabled={props.pending}
              value={models}
              onChange={(event) => setModels(event.currentTarget.value)}
            />
          </label>
        </>
      ) : null}
      <Button
        size="sm"
        type="submit"
        disabled={
          props.pending ||
          !changed ||
          name.trim().length === 0 ||
          (compatible && (baseUrl.trim().length === 0 || modelList.length === 0))
        }
      >
        Save changes
      </Button>
    </form>
  );
}

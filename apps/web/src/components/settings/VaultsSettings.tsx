import { useAtomValue } from "@effect/atom-react";
import {
  IDENTITY_TTL_DEFAULT_SECONDS,
  IDENTITY_TTL_MAX_SECONDS,
  IDENTITY_TTL_MIN_SECONDS,
  type AuthAccount,
  type EnvironmentId,
  looksLikeCredential,
  MAIN_VAULT_ID,
  parseTemplate,
  previewTemplate,
  secretNameRisk,
  templateNames,
  templatePathNames,
  type SpaceId,
  type VaultEntry,
  type VaultEntryClass,
  type VaultEntryDelivery,
  type VaultEntryId,
  type SecretProviderId,
  type VaultProviderScopes,
  type VaultSummary,
} from "@t3tools/contracts";
import { entryActions, loadVaultOverview, vaultActions } from "@t3tools/client-runtime/vaults";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { fetchAccount } from "../../environments/primary/userAccounts";
import { revealVaultSecret } from "../../environments/primary/vaults";
import { isElectron } from "../../env";
import { errorMessageOf } from "../../lib/errorMessage";
import { useCurrentSpace } from "../../state/currentSpace";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { emptyStepUp, StepUpFields, toStepUp } from "./AccountSettingsSection";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SpaceDefaultVaults, VaultAllowances } from "./VaultChoices";
import { settle } from "./vaultCommands";

const VALUE_INPUT_PROPS = {
  // Not a login: no password manager prompt, but hidden as typed.
  type: "text",
  className: "[-webkit-text-security:disc]",
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
} as const;
/** A Variable's value is meant to be seen: shown as typed. */
const SEEN_INPUT_PROPS = {
  type: "text",
  autoComplete: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
} as const;
/** A revealed value stays on screen this long, at most. */
const REVEAL_MS = 60_000;
const VAULT_SURFACE = isElectron ? "desktop" : "web";
const CONFIRM_DANGEROUS = "This value changes how tools run";

const nameHint = (name: string, isOwner: boolean) => {
  if (name.length === 0) return null;
  switch (secretNameRisk(name)) {
    case "invalid":
      return "Capital letters, digits and _, not starting with a digit.";
    case "gateway":
      return "Reserved: the Hub sets it.";
    case "dangerous":
      return isOwner
        ? "It changes how the agent's tools run or whom they trust: confirm to save it."
        : "It changes how the agent's tools run or whom they trust: only the Owner sets it.";
    default:
      return null;
  }
};
const isDangerous = (name: string) => secretNameRisk(name) === "dangerous";

const CREDENTIAL_WARNING =
  "This looks like a credential. A Variable's value is shown to everyone who sees it and never masked: make it a Secret unless it is meant to be seen.";
const SEAL_CONFIRM = (name: string) =>
  `Seal ${name}? Nobody will reveal it again, not even you. Only a new value can make it revealable.`;

type AddKind = VaultEntryClass | "template" | "identity";
const KIND_ITEMS: ReadonlyArray<{ readonly value: AddKind; readonly label: string }> = [
  { value: "secret", label: "Secret" },
  { value: "variable", label: "Variable" },
  { value: "template", label: "Template" },
];
/** Vaults ticket 07: a token the Hub signs for each Thread; the Owner's alone. */
const OWNER_KIND_ITEMS: ReadonlyArray<{ readonly value: AddKind; readonly label: string }> = [
  ...KIND_ITEMS,
  { value: "identity", label: "Workload identity" },
];
const IDENTITY_HINT =
  "A token the Hub signs for each Thread, for this audience only: delivered as a file the Hub refreshes before it expires, never shown. The system that verifies it trusts this Hub's issuer.";

const DELIVERY_ITEMS: ReadonlyArray<{
  readonly value: VaultEntryDelivery;
  readonly label: string;
}> = [
  { value: "env", label: "Environment variable" },
  { value: "file", label: "File" },
  { value: "none", label: "Not delivered" },
];
const DELIVERY_HINT: Record<VaultEntryDelivery, string> = {
  env: "",
  file: "Written to a file in memory on the Thread's machine; the variable holds its path. A machine without memory for it refuses the Thread.",
  none: "Only templates of this Vault use it: no process gets it by itself.",
};

/** Why a template's text would be refused by the Hub, from the Vault's entries (names only). */
const templateProblem = (text: string, entries: ReadonlyArray<VaultEntry>): string | null => {
  const parsed = parseTemplate(text);
  if (parsed._tag === "invalid") return parsed.message;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const paths = templatePathNames(parsed.parts);
  for (const name of templateNames(parsed.parts)) {
    const entry = byName.get(name);
    if (entry === undefined) return `${name} is not an entry of this Vault.`;
    if (entry.kind === "template") return `${name} is a template: a template never names another.`;
    if (
      entry.kind === "identity" &&
      parsed.parts.some(
        (part) =>
          part._tag === "ref" &&
          part.name === name &&
          !(part.filters.length === 1 && part.filters[0] === "path"),
      )
    ) {
      return `${name} is a workload identity token: use {{ ${name} | path }}, never the token.`;
    }
    if (paths.has(name) && entry.delivery !== "file") {
      return `{{ ${name} | path }} takes ${name}'s file: deliver ${name} as a file.`;
    }
  }
  return null;
};

/** What a change to an entry sends, besides its name: a value, a class, the reveal choice. */
interface EntryChange {
  readonly value?: string;
  readonly class?: VaultEntryClass;
  readonly allowReveal?: boolean;
  readonly delivery?: VaultEntryDelivery;
  readonly confirmDangerous: boolean;
}

/** How an entry reaches a process: a select for whoever edits it. */
function DeliverySelect(props: {
  readonly label: string;
  readonly value: VaultEntryDelivery;
  readonly disabled: boolean;
  readonly allowNone: boolean;
  readonly onChange: (next: VaultEntryDelivery) => void;
}) {
  const items = props.allowNone
    ? DELIVERY_ITEMS
    : DELIVERY_ITEMS.filter((item) => item.value !== "none");
  return (
    <Select
      disabled={props.disabled}
      items={items}
      value={props.value}
      onValueChange={(next) => {
        const found = items.find((item) => item.value === next);
        if (found !== undefined) props.onChange(found.value);
      }}
    >
      <SelectTrigger aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The value form an entry row opens: a plain replace, or one of the changes that need a value. */
type ValueMode = "replace" | "allow-reveal" | "make-variable";
const VALUE_MODE_LABEL: Record<ValueMode, string> = {
  replace: "Save value",
  "allow-reveal": "Save and allow reveal",
  "make-variable": "Save as Variable",
};

/** The live «looks like a credential» line for a Variable being typed. Never blocks. */
function CredentialWarning(props: { readonly name: string; readonly value: string }) {
  if (!looksLikeCredential(props.name, props.value.length === 0 ? undefined : props.value)) {
    return null;
  }
  return (
    <span className="text-xs text-warning" role="status">
      {CREDENTIAL_WARNING}
    </span>
  );
}

/** The Owner's explicit confirmation for a name that changes how tools run. */
function ConfirmDangerous(props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-destructive">
      <Checkbox
        aria-label={CONFIRM_DANGEROUS}
        checked={props.checked}
        onCheckedChange={(checked) => props.onChange(checked === true)}
      />
      {CONFIRM_DANGEROUS}
    </label>
  );
}

function useVaultCommands() {
  return {
    list: useAtomCommand(serverEnvironment.listVaults, "list Vaults"),
    create: useAtomCommand(serverEnvironment.createVault, "create a Vault"),
    remove: useAtomCommand(serverEnvironment.deleteVault, "delete a Vault"),
    entries: useAtomCommand(serverEnvironment.listVaultEntries, "list a Vault's secrets"),
    // The input holds a value: keep failures (and their causes) out of the console.
    put: useAtomCommand(serverEnvironment.putVaultEntry, {
      label: "save a secret",
      reportFailure: false,
      reportDefect: false,
    }),
    deleteEntry: useAtomCommand(serverEnvironment.deleteVaultEntry, "delete a secret"),
    link: useAtomCommand(serverEnvironment.linkVaultEntry, "link a secret"),
    copy: useAtomCommand(serverEnvironment.copyVaultEntry, "copy a secret"),
  };
}
type VaultCommands = ReturnType<typeof useVaultCommands>;

/**
 * Settings → Vaults: named sets of secrets, each under an environment-variable name. The Owner
 * manages them and reveals values; an Organization's Admins add, replace and delete its secrets
 * without seeing them; Members and Guests see names only. See docs/internals/secrets.md.
 */
export function VaultsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : <VaultsPage environmentId={environmentId} />}
    </SettingsPageContainer>
  );
}

function VaultsPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const commands = useVaultCommands();
  // The session may change secrets at all (access:write); each Vault then says what is allowed.
  const mayWrite = useAtomValue(serverEnvironment.putVaultEntry.permissionAtom(environmentId));
  const mayCreate = useAtomValue(serverEnvironment.createVault.permissionAtom(environmentId));
  const spaceView = useCurrentSpace((state) => state.view);
  const organizations = (spaceView?.spaces ?? []).filter((space) => space.kind === "organization");
  const [vaults, setVaults] = useState<ReadonlyArray<VaultSummary> | null>(null);
  const [entries, setEntries] = useState<Readonly<Record<string, ReadonlyArray<VaultEntry>>>>({});
  const [error, setError] = useState<string | null>(null);

  const listVaults = () => settle(commands.list({ environmentId, input: {} }));
  const listEntries = (vaultId: VaultSummary["id"]) =>
    settle(commands.entries({ environmentId, input: { vaultId } })).then(
      (result) => [vaultId, result.entries] as const,
    );

  /** Every Vault the User sees, their names read in parallel. */
  const fetchAll = useEffectEvent((target: EnvironmentId) =>
    loadVaultOverview({
      list: () => settle(commands.list({ environmentId: target, input: {} })),
      entries: (vaultId) => settle(commands.entries({ environmentId: target, input: { vaultId } })),
    }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Vaults the signed-in User sees from the Hub when the page opens.
  useEffect(() => {
    let cancelled = false;
    void fetchAll(environmentId).then(
      (loaded) => {
        if (cancelled) return;
        setVaults(loaded.vaults);
        setEntries(loaded.entries);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessageOf(cause, "Could not read the Vaults."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  /** After a change: the list (counts) and the one Vault that changed; every Vault for `all`. */
  const refresh = async (changed: VaultSummary["id"] | "all") => {
    try {
      const listed = await listVaults();
      const targets =
        changed === "all"
          ? listed.vaults.map((vault) => vault.id)
          : listed.vaults.filter((vault) => vault.id === changed).map((vault) => vault.id);
      const loaded = await Promise.all(targets.map(listEntries));
      setVaults(listed.vaults);
      setEntries((previous) => ({ ...previous, ...Object.fromEntries(loaded) }));
      setError(null);
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not read the Vaults."));
    }
  };

  const mainEntries = (entries[MAIN_VAULT_ID] ?? []).filter((entry) => entry.kind !== "link");

  return (
    <>
      <SettingsSection id="vaults" title="Vaults">
        <SettingsRow
          title="Secrets for your agents"
          description={
            isOwner
              ? "Each entry reaches agents as an environment variable. A Variable is configuration: everyone who sees it reads its value, Guests excepted. A Secret is never shown; a new one is sealed (nobody reveals it, not even you) unless you allow reveal. An Organization's Admins add, replace and delete its entries without seeing Secrets."
              : "The entries your Organizations' agents receive, by name. Variables show their value; Secrets never do."
          }
          status={
            error === null ? null : (
              <span className="text-destructive" role="alert">
                {error}
              </span>
            )
          }
        />
        {isOwner && mayCreate ? (
          <NewVaultForm
            organizations={organizations.map((space) => ({ id: space.id, name: space.name }))}
            onCreate={async (input) => {
              await settle(commands.create({ environmentId, input }));
              await refresh("all");
            }}
          />
        ) : null}
      </SettingsSection>
      {vaults === null ? null : vaults.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">No Vault is shared with you.</p>
      ) : (
        vaults.map((vault) => (
          <VaultSection
            key={vault.id}
            environmentId={environmentId}
            commands={commands}
            vault={vault}
            mayWrite={mayWrite}
            isOwner={isOwner}
            entries={entries[vault.id] ?? []}
            mainEntries={vault.isMain ? [] : mainEntries}
            onChanged={(all) => refresh(all ? "all" : vault.id)}
          />
        ))
      )}
      <SpaceDefaultVaults environmentId={environmentId} />
    </>
  );
}

/** Stands for «no Organization»: the Vault is the Owner's own. */
const ONLY_YOU = "only-you";

function NewVaultForm(props: {
  readonly organizations: ReadonlyArray<{ readonly id: SpaceId; readonly name: string }>;
  readonly onCreate: (input: {
    readonly name: string;
    readonly spaceId: SpaceId | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [spaceId, setSpaceId] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An Organization that is gone (archived) falls back to «Only you».
  const chosenSpace = props.organizations.some((space) => space.id === spaceId) ? spaceId : "";
  const organizationItems = [
    { value: ONLY_YOU, label: "Only you (not an Organization's)" },
    ...props.organizations.map((space) => ({ value: space.id as string, label: space.name })),
  ];
  return (
    <form
      className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void props
          .onCreate({
            name: name.trim(),
            spaceId: chosenSpace === "" ? null : (chosenSpace as SpaceId),
          })
          .then(
            () => setName(""),
            (cause: unknown) => setError(errorMessageOf(cause, "Could not create the Vault.")),
          )
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Vault name
        <Input
          aria-label="Vault name"
          nativeInput
          disabled={pending}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium sm:w-56">
        Organization
        <Select
          disabled={pending}
          items={organizationItems}
          value={chosenSpace === "" ? ONLY_YOU : chosenSpace}
          onValueChange={(value) => setSpaceId(value === null || value === ONLY_YOU ? "" : value)}
        >
          <SelectTrigger aria-label="Organization">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {organizationItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      <Button disabled={pending || name.trim().length === 0} size="sm" type="submit">
        Create Vault
      </Button>
      {error === null ? null : (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

/** Runs a change: resolves true once it is saved, false when it failed (and says why). */
type Act = (work: () => Promise<string | null>, all?: boolean) => Promise<boolean>;

function VaultSection(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: VaultCommands;
  readonly vault: VaultSummary;
  readonly mayWrite: boolean;
  readonly isOwner: boolean;
  readonly entries: ReadonlyArray<VaultEntry>;
  readonly mainEntries: ReadonlyArray<VaultEntry>;
  readonly onChanged: (all: boolean) => Promise<void>;
}) {
  const { vault, commands, environmentId } = props;
  const canEdit = vaultActions(vault, { mayWrite: props.mayWrite, surface: VAULT_SURFACE }).add;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act: Act = async (work, all = false) => {
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      if (message !== null) setNotice(message);
      await props.onChanged(all);
      return true;
    } catch (cause) {
      setError(errorMessageOf(cause, "That did not work."));
      return false;
    }
  };
  const savedMessage = (name: string, verb: string, warnings: ReadonlyArray<string>) =>
    warnings.includes("not-used-by-template")
      ? `${name} ${verb}. No template of this Vault uses it yet, so no process gets it.`
      : warnings.includes("short-value")
        ? `${name} ${verb}. Shorter than 6 characters: it won't be masked in the history.`
        : warnings.includes("looks-like-credential")
          ? `${name} ${verb}. ${CREDENTIAL_WARNING}`
          : `${name} ${verb}.`;
  const change = (entry: VaultEntry, input: EntryChange) =>
    act(async () => {
      const result = await settle(
        commands.put({
          environmentId,
          input: {
            vaultId: vault.id,
            entryId: entry.id,
            name: entry.name,
            ...(input.value === undefined ? {} : { value: Redacted.make(input.value) }),
            ...(input.class === undefined ? {} : { class: input.class }),
            ...(input.allowReveal === undefined ? {} : { allowReveal: input.allowReveal }),
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
            ...(input.confirmDangerous ? { confirmDangerous: true } : {}),
          },
        }),
      );
      const verb =
        input.delivery !== undefined
          ? `is now delivered as ${DELIVERY_ITEMS.find((item) => item.value === input.delivery)?.label.toLowerCase() ?? input.delivery}`
          : input.class === "variable"
            ? "is now a Variable"
            : input.class === "secret"
              ? "is now a sealed Secret"
              : input.allowReveal === false
                ? "sealed"
                : input.allowReveal === true
                  ? "replaced; you can reveal it"
                  : "replaced";
      return savedMessage(entry.name, verb, result.warnings);
    });
  const owner = vault.isMain
    ? "Yours alone; reaches Organizations only through links or copies"
    : vault.spaceName === null
      ? "Yours alone"
      : `${vault.spaceName}'s`;
  return (
    <SettingsSection id={`vault-${vault.id}`} title={vault.name}>
      <SettingsRow
        title={`${vault.entryCount} ${vault.entryCount === 1 ? "secret" : "secrets"}`}
        description={`${owner}.${vault.archived ? " Archived." : ""}${canEdit && !vault.canReveal ? " You can add, replace and delete secrets, never see them." : ""}`}
        status={
          error !== null ? (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          ) : notice !== null ? (
            <span className="text-muted-foreground" role="status">
              {notice}
            </span>
          ) : null
        }
        control={
          vault.canManage && props.mayWrite && !vault.isMain ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Delete Vault ${vault.name}`}
              onClick={() => {
                if (!window.confirm(`Delete ${vault.name} and its secrets?`)) return;
                void act(async () => {
                  await settle(commands.remove({ environmentId, input: { vaultId: vault.id } }));
                  return null;
                }, true);
              }}
            >
              Delete Vault
            </Button>
          ) : null
        }
      />
      <ul
        className="flex flex-col divide-y divide-border/60"
        aria-label={`Secrets in ${vault.name}`}
      >
        {props.entries.map((entry) => (
          <EntryRow
            key={entry.id}
            vault={vault}
            canEdit={canEdit}
            isOwner={props.isOwner}
            entry={entry}
            onChange={(input) => change(entry, input)}
            onDelete={() =>
              act(async () => {
                const input = { vaultId: vault.id, entryId: entry.id };
                const asked = await settle(commands.deleteEntry({ environmentId, input }));
                if (asked.deleted) return null;
                const names = asked.brokenLinks
                  .map((link) => `${link.vaultName} → ${link.name}`)
                  .join(", ");
                if (!window.confirm(`Deleting ${entry.name} breaks these Secret links: ${names}`)) {
                  return null;
                }
                await settle(
                  commands.deleteEntry({ environmentId, input: { ...input, breakLinks: true } }),
                );
                return null;
              }, vault.isMain)
            }
          />
        ))}
      </ul>
      {canEdit ? (
        <AddSecretForm
          vaultName={vault.name}
          isOwner={props.isOwner}
          entries={props.entries}
          onAdd={(name, value, options) =>
            act(async () => {
              const result = await settle(
                commands.put({
                  environmentId,
                  input: {
                    vaultId: vault.id,
                    name,
                    ...(options.kind === "template"
                      ? { template: { text: value } }
                      : options.kind === "identity"
                        ? {
                            identity: {
                              audience: value,
                              ttlSeconds: options.ttlSeconds ?? IDENTITY_TTL_DEFAULT_SECONDS,
                            },
                          }
                        : { value: Redacted.make(value), class: options.kind }),
                    ...(options.kind === "secret" && options.allowReveal
                      ? { allowReveal: true }
                      : {}),
                    delivery: options.delivery,
                    ...(options.confirmDangerous ? { confirmDangerous: true } : {}),
                  },
                }),
              );
              return savedMessage(name, "saved", result.warnings);
            })
          }
        />
      ) : null}
      {canEdit ? (
        <AddProviderEntryForm
          environmentId={environmentId}
          vaultId={vault.id}
          vaultName={vault.name}
          onAdd={(name, provider) =>
            act(async () => {
              await settle(
                commands.put({ environmentId, input: { vaultId: vault.id, name, provider } }),
              );
              return `${name} saved: read from its provider when a process starts.`;
            })
          }
        />
      ) : null}
      {canEdit && props.isOwner && props.mainEntries.length > 0 ? (
        <FromMainForm
          vaultName={vault.name}
          mainEntries={props.mainEntries}
          onAdd={(kind, sourceEntryId, name, confirmDangerous) =>
            act(async () => {
              const input = {
                vaultId: vault.id,
                sourceEntryId,
                ...(name.length > 0 ? { name } : {}),
                ...(confirmDangerous ? { confirmDangerous } : {}),
              };
              await settle(
                kind === "link"
                  ? commands.link({ environmentId, input })
                  : commands.copy({ environmentId, input }),
              );
              return null;
            })
          }
        />
      ) : null}
      {vault.canManage && props.mayWrite && !vault.isMain && vault.spaceId === null ? (
        <VaultAllowances
          environmentId={environmentId}
          vault={vault}
          onChanged={() => props.onChanged(false)}
        />
      ) : null}
    </SettingsSection>
  );
}

function EntryRow(props: {
  readonly vault: VaultSummary;
  readonly canEdit: boolean;
  readonly isOwner: boolean;
  readonly entry: VaultEntry;
  readonly onChange: (change: EntryChange) => Promise<boolean>;
  readonly onDelete: () => Promise<boolean>;
}) {
  const { vault, entry } = props;
  const [mode, setMode] = useState<ValueMode | null>(null);
  const [value, setValue] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const dangerous = isDangerous(entry.name);
  // Someone else's dangerous name: replacing it is the Owner's alone.
  const actions = entryActions(vault, entry, {
    mayWrite: props.canEdit,
    surface: VAULT_SURFACE,
    isOwner: props.isOwner,
  });
  const isVariable = entry.class === "variable";
  const toggle = (next: ValueMode) => setMode((open) => (open === next ? null : next));
  // A Variable stays a Variable when its value is replaced, so it shows as typed.
  const shownAsTyped = mode === "make-variable" || (mode === "replace" && isVariable);
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm font-medium">{entry.name}</code>
        {isVariable ? (
          <Badge variant="outline">Variable</Badge>
        ) : entry.sealed ? (
          <Badge variant="outline">Sealed</Badge>
        ) : null}
        {isVariable && entry.value !== undefined ? (
          <code
            aria-label={`Value of ${entry.name}`}
            className="rounded bg-muted px-2 py-0.5 text-xs break-all"
          >
            {entry.value}
          </code>
        ) : null}
        {entry.kind === "provider" ? (
          // Ticket 02: read from a Secret provider when a process starts; never shown here.
          entry.broken ? (
            <Badge variant="destructive">broken</Badge>
          ) : (
            <Badge variant="outline">
              Provider: {entry.provider?.label ?? "gone"}
              {entry.provider?.reference ? ` (${entry.provider.reference})` : ""}
            </Badge>
          )
        ) : entry.kind === "link" ? (
          entry.broken ? (
            <Badge variant="destructive">broken</Badge>
          ) : (
            <Badge variant="outline">
              linked from Main vault{entry.linkedFrom === null ? "" : ` (${entry.linkedFrom.name})`}
            </Badge>
          )
        ) : entry.kind === "copy" ? (
          <Badge variant="outline">copy</Badge>
        ) : entry.kind === "template" ? (
          entry.broken ? (
            <Badge variant="destructive">broken</Badge>
          ) : (
            <Badge variant="outline">Template</Badge>
          )
        ) : entry.kind === "identity" ? (
          <Badge variant="outline">
            Workload identity: {entry.identity?.audience ?? ""}
            {entry.identity === undefined
              ? ""
              : ` (${Math.round(entry.identity.ttlSeconds / 60)} min)`}
          </Badge>
        ) : null}
        {entry.delivery === "file" ? <Badge variant="outline">File</Badge> : null}
        {entry.delivery === "none" ? <Badge variant="outline">Not delivered</Badge> : null}
        {entry.unmasked && !isVariable ? <Badge variant="outline">not masked</Badge> : null}
        {dangerous ? <Badge variant="outline">changes how tools run</Badge> : null}
        {entry.description === null ? null : (
          <span className="text-xs text-muted-foreground">{entry.description}</span>
        )}
        <span className="ms-auto flex flex-wrap gap-1">
          {props.canEdit &&
          entry.kind !== "identity" &&
          (entry.kind !== "provider" || props.isOwner) ? (
            <span className="w-48">
              <DeliverySelect
                label={`Delivery of ${entry.name}`}
                value={entry.delivery}
                disabled={false}
                allowNone={entry.kind !== "template"}
                onChange={(delivery) => {
                  if (delivery !== entry.delivery) {
                    void props.onChange({ delivery, confirmDangerous: dangerous });
                  }
                }}
              />
            </span>
          ) : null}
          {actions.replace ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Replace value of ${entry.name}`}
              onClick={() => toggle("replace")}
            >
              Replace value
            </Button>
          ) : null}
          {actions.seal ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Seal ${entry.name}`}
              onClick={() => {
                if (!window.confirm(SEAL_CONFIRM(entry.name))) return;
                // Confirming the seal confirms a name that changes how tools run (the Owner's).
                void props.onChange({ allowReveal: false, confirmDangerous: dangerous });
              }}
            >
              Seal
            </Button>
          ) : null}
          {actions.allowReveal ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Allow reveal of ${entry.name}`}
              onClick={() => toggle("allow-reveal")}
            >
              Allow reveal
            </Button>
          ) : null}
          {actions.makeVariable ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Make ${entry.name} a Variable`}
              onClick={() => toggle("make-variable")}
            >
              Make variable
            </Button>
          ) : null}
          {actions.makeSecret ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Make ${entry.name} a Secret`}
              onClick={() => {
                if (dangerous && !window.confirm(`${CONFIRM_DANGEROUS}. Make it a Secret?`)) {
                  return;
                }
                void props.onChange({ class: "secret", confirmDangerous: dangerous });
              }}
            >
              Make secret
            </Button>
          ) : null}
          {props.canEdit ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Delete ${entry.name}`}
              onClick={() => void props.onDelete()}
            >
              Delete
            </Button>
          ) : null}
        </span>
      </div>
      {entry.kind === "template" && entry.template?.text != null ? (
        <pre
          aria-label={`Template of ${entry.name}`}
          className="max-h-40 overflow-auto rounded bg-muted px-2 py-1 text-xs whitespace-pre-wrap"
        >
          {entry.template.text}
        </pre>
      ) : null}
      {mode === null ? null : (
        <form
          className="flex max-w-md flex-col gap-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void props
              .onChange({
                value,
                ...(mode === "allow-reveal" ? { allowReveal: true } : {}),
                ...(mode === "make-variable" ? { class: "variable" as const } : {}),
                confirmDangerous: confirmed,
              })
              .then((saved) => {
                // A failed save keeps what was typed.
                if (!saved) return;
                setValue("");
                setConfirmed(false);
                setMode(null);
              });
          }}
        >
          {mode === "allow-reveal" ? (
            <span className="text-xs text-muted-foreground">
              A sealed value is never read back: allowing reveal takes a new one.
            </span>
          ) : mode === "make-variable" ? (
            <span className="text-xs text-muted-foreground">
              A Secret's value is never shown: a Variable takes a new one, visible to everyone who
              sees it.
            </span>
          ) : null}
          <div className="flex gap-2">
            <Input
              aria-label={`New value of ${entry.name}`}
              nativeInput
              {...(shownAsTyped ? SEEN_INPUT_PROPS : VALUE_INPUT_PROPS)}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <Button
              disabled={value.length === 0 || (dangerous && !confirmed)}
              size="sm"
              type="submit"
            >
              {VALUE_MODE_LABEL[mode]}
            </Button>
          </div>
          {shownAsTyped ? <CredentialWarning name={entry.name} value={value} /> : null}
          {dangerous ? <ConfirmDangerous checked={confirmed} onChange={setConfirmed} /> : null}
        </form>
      )}
      {actions.reveal && !entry.broken ? (
        // A new version hides a value revealed before it.
        <RevealControl key={`${entry.id}:${entry.version}`} vault={vault} entry={entry} />
      ) : null}
    </li>
  );
}

type RevealStage =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "step-up";
      readonly account: AuthAccount;
      readonly stepUp: ReturnType<typeof emptyStepUp>;
    }
  | { readonly _tag: "shown"; readonly value: string };

/** «Reveal»: the Owner's, after their strong factor; shown for a minute at most, then hidden. */
function RevealControl(props: { readonly vault: VaultSummary; readonly entry: VaultEntry }) {
  const { entry } = props;
  const [stage, setStage] = useState<RevealStage>({ _tag: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = stage._tag === "shown";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides a revealed value after REVEAL_MS, so it does not stay on an unattended screen.
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setStage({ _tag: "idle" }), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
  const run = (work: () => Promise<void>) => {
    setPending(true);
    setError(null);
    void work()
      .catch((cause: unknown) => setError(errorMessageOf(cause, "Could not reveal it.")))
      .finally(() => setPending(false));
  };
  if (stage._tag === "idle") {
    return (
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Reveal ${entry.name}`}
          disabled={pending}
          onClick={() =>
            run(async () => {
              const account = await fetchAccount();
              setStage({ _tag: "step-up", account, stepUp: emptyStepUp(account) });
            })
          }
        >
          Reveal
        </Button>
        {error === null ? null : (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }
  if (stage._tag === "shown") {
    return (
      <div className="flex items-center gap-2">
        <code
          aria-label={`Value of ${entry.name}`}
          className="rounded bg-muted px-2 py-1 text-xs break-all"
        >
          {stage.value}
        </code>
        <Button size="xs" variant="ghost" onClick={() => setStage({ _tag: "idle" })}>
          Hide
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex max-w-sm flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(async () => {
          const value = await revealVaultSecret(
            toStepUp(stage.account, stage.stepUp),
            props.vault.id,
            entry.id,
          );
          setStage({ _tag: "shown", value });
        });
      }}
    >
      <StepUpFields
        account={stage.account}
        disabled={pending}
        value={stage.stepUp}
        onChange={(stepUp) => setStage({ ...stage, stepUp })}
      />
      <div className="flex gap-2">
        <Button disabled={pending} size="sm" type="submit">
          {pending ? "Revealing…" : `Confirm and reveal ${entry.name}`}
        </Button>
        <Button
          disabled={pending}
          size="sm"
          variant="ghost"
          onClick={() => setStage({ _tag: "idle" })}
        >
          Cancel
        </Button>
      </div>
      {error === null ? null : (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

function AddSecretForm(props: {
  readonly vaultName: string;
  readonly isOwner: boolean;
  readonly entries: ReadonlyArray<VaultEntry>;
  readonly onAdd: (
    name: string,
    value: string,
    options: {
      readonly kind: AddKind;
      readonly allowReveal: boolean;
      readonly delivery: VaultEntryDelivery;
      readonly confirmDangerous: boolean;
      /** A workload identity token's lifetime. */
      readonly ttlSeconds?: number;
    },
  ) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<AddKind>("secret");
  const [delivery, setDelivery] = useState<VaultEntryDelivery>("env");
  const [allowReveal, setAllowReveal] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [minutes, setMinutes] = useState(String(IDENTITY_TTL_DEFAULT_SECONDS / 60));
  const isVariable = kind === "variable";
  const isTemplate = kind === "template";
  const isIdentity = kind === "identity";
  const ttlSeconds = Math.round(Number(minutes) * 60);
  const ttlValid =
    Number.isFinite(ttlSeconds) &&
    ttlSeconds >= IDENTITY_TTL_MIN_SECONDS &&
    ttlSeconds <= IDENTITY_TTL_MAX_SECONDS;
  const hint = nameHint(name, props.isOwner);
  const dangerous = isDangerous(name);
  // A template's text holds names only: checked and previewed here, as `[NAME]`, never a value.
  const parsed = isTemplate && value.length > 0 ? parseTemplate(value) : null;
  const problem = isTemplate && value.length > 0 ? templateProblem(value, props.entries) : null;
  const preview = parsed?._tag === "parsed" ? previewTemplate(parsed.parts) : null;
  const chosenDelivery = isIdentity ? "file" : isTemplate && delivery === "none" ? "env" : delivery;
  const blocked =
    secretNameRisk(name) === "invalid" ||
    secretNameRisk(name) === "gateway" ||
    problem !== null ||
    (isIdentity && !ttlValid) ||
    (dangerous && (!props.isOwner || !confirmed));
  return (
    <form
      aria-label={`Add a secret to ${props.vaultName}`}
      className="flex flex-col gap-2 px-4 py-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        void props
          .onAdd(name, value, {
            kind,
            allowReveal: kind === "secret" && allowReveal,
            delivery: chosenDelivery,
            confirmDangerous: dangerous && confirmed,
            ...(isIdentity ? { ttlSeconds } : {}),
          })
          .then((saved) => {
            // A failed save keeps what was typed.
            if (!saved) return;
            setName("");
            setValue("");
            setAllowReveal(false);
            setDelivery("env");
            setConfirmed(false);
          })
          .finally(() => setPending(false));
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-32">
          Kind
          <Select
            disabled={pending}
            items={props.isOwner ? OWNER_KIND_ITEMS : KIND_ITEMS}
            value={kind}
            onValueChange={(next) =>
              setKind(
                next === "variable" || next === "template" || next === "identity" ? next : "secret",
              )
            }
          >
            <SelectTrigger aria-label="Kind">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {(props.isOwner ? OWNER_KIND_ITEMS : KIND_ITEMS).map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
          Name
          <Input
            aria-label="Name"
            nativeInput
            disabled={pending}
            maxLength={128}
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.currentTarget.value.toUpperCase())}
          />
        </label>
        {isIdentity ? (
          <>
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
              Audience
              <Input
                aria-label="Audience"
                nativeInput
                disabled={pending}
                maxLength={256}
                spellCheck={false}
                placeholder="https://kubernetes.default.svc"
                value={value}
                onChange={(event) => setValue(event.currentTarget.value.trim())}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium sm:w-28">
              Lifetime (min)
              <Input
                aria-label="Lifetime in minutes"
                nativeInput
                disabled={pending}
                inputMode="numeric"
                value={minutes}
                onChange={(event) => setMinutes(event.currentTarget.value)}
              />
            </label>
          </>
        ) : isTemplate ? null : (
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Value
            <Input
              aria-label="Value"
              nativeInput
              disabled={pending}
              {...(isVariable ? SEEN_INPUT_PROPS : VALUE_INPUT_PROPS)}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-48">
          Delivery
          <DeliverySelect
            label="Delivery"
            value={chosenDelivery}
            disabled={pending || isIdentity}
            allowNone={!isTemplate && !isIdentity}
            onChange={setDelivery}
          />
        </label>
        <Button
          disabled={pending || blocked || name.length === 0 || value.length === 0}
          size="sm"
          type="submit"
        >
          {isIdentity
            ? "Add identity"
            : isTemplate
              ? "Add template"
              : isVariable
                ? "Add variable"
                : "Add secret"}
        </Button>
      </div>
      {isTemplate ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Template
            <Textarea
              aria-label="Template"
              rows={6}
              spellCheck={false}
              disabled={pending}
              value={value}
              placeholder="server: {{ KUBE_SERVER }}&#10;tokenFile: {{ KUBE_TOKEN | path }}"
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
          <span className="text-xs text-muted-foreground">
            Names entries of this Vault: {"{{ NAME }}"}, or {"{{ NAME | filter }}"} with base64,
            base64decode, urlencode, json, trim or path. A Secret among them makes it a sealed
            Secret.
          </span>
          {problem === null ? null : (
            <span className="text-xs text-destructive" role="alert">
              {problem}
            </span>
          )}
          {preview === null ? null : (
            <pre
              aria-label="Template preview"
              className="max-h-40 overflow-auto rounded bg-muted px-2 py-1 text-xs whitespace-pre-wrap"
            >
              {preview}
            </pre>
          )}
        </div>
      ) : null}
      {isIdentity ? (
        <span className="text-xs text-muted-foreground">
          {IDENTITY_HINT}
          {ttlValid ? "" : " Its lifetime is 1 to 60 minutes."}
        </span>
      ) : DELIVERY_HINT[chosenDelivery].length === 0 ? null : (
        <span className="text-xs text-muted-foreground">{DELIVERY_HINT[chosenDelivery]}</span>
      )}
      {kind !== "secret" ? null : (
        <label className="flex items-center gap-2 text-xs font-medium">
          <Checkbox
            aria-label="Allow reveal"
            checked={allowReveal}
            disabled={pending}
            onCheckedChange={(checked) => setAllowReveal(checked === true)}
          />
          Allow reveal
          <span className="font-normal text-muted-foreground">
            {allowReveal
              ? "The Owner can read it back, with a strong factor."
              : "Sealed: nobody reads it back, not even the Owner."}
          </span>
        </label>
      )}
      {isVariable ? <CredentialWarning name={name} value={value} /> : null}
      {hint === null ? null : <span className="text-xs text-destructive">{hint}</span>}
      {dangerous && props.isOwner ? (
        <ConfirmDangerous checked={confirmed} onChange={setConfirmed} />
      ) : null}
    </form>
  );
}

/**
 * «Add a Provider entry» (Vaults ticket 03): a sealed Secret read from a provider when a process
 * starts, through a Provider scope allowed to this Vault (or the Owner's «Direct» access). Shown
 * only when there is one to choose.
 */
function AddProviderEntryForm(props: {
  readonly environmentId: EnvironmentId;
  readonly vaultId: VaultSummary["id"];
  readonly vaultName: string;
  readonly onAdd: (
    name: string,
    provider: {
      readonly providerId: SecretProviderId;
      readonly reference: string;
      readonly scopeId: string | null;
    },
  ) => Promise<boolean>;
}) {
  const load = useAtomCommand(serverEnvironment.vaultProviderScopes, "list provider scopes");
  const [choices, setChoices] = useState<VaultProviderScopes | null>(null);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);
  const fetchChoices = useEffectEvent((vaultId: VaultSummary["id"]) =>
    settle(load({ environmentId: props.environmentId, input: { vaultId } })).catch(() => null),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Provider scopes this Vault may use when its section opens.
  useEffect(() => {
    let cancelled = false;
    void fetchChoices(props.vaultId).then((loaded) => {
      if (!cancelled) setChoices(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [props.vaultId]);
  const items = [
    ...(choices?.scopes ?? []).map((scope) => ({
      value: `scope:${scope.id}`,
      label: `${scope.label} (${scope.providerLabel}: ${scope.allowedPaths.join(", ")})`,
      providerId: scope.providerId,
      scopeId: scope.id as string | null,
      placeholder: scope.referencePlaceholder,
    })),
    ...(choices?.direct ?? []).map((provider) => ({
      value: `direct:${provider.providerId}`,
      label: `${provider.providerLabel} (Direct)`,
      providerId: provider.providerId,
      scopeId: null as string | null,
      placeholder: provider.referencePlaceholder,
    })),
  ];
  if (items.length === 0) return null;
  const chosen = items.find((item) => item.value === source) ?? items[0]!;
  return (
    <form
      aria-label={`Add a Provider entry to ${props.vaultName}`}
      className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        void props
          .onAdd(name, {
            providerId: chosen.providerId,
            reference: reference.trim(),
            scopeId: chosen.scopeId,
          })
          .then((saved) => {
            if (!saved) return;
            setName("");
            setReference("");
          })
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-col gap-1 text-xs font-medium sm:w-56">
        Source: Provider
        <Select
          items={items.map((item) => ({ value: item.value, label: item.label }))}
          value={chosen.value}
          onValueChange={(value) => setSource(value ?? "")}
        >
          <SelectTrigger aria-label="Provider scope">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Name
        <Input
          aria-label="Provider entry name"
          nativeInput
          disabled={pending}
          maxLength={128}
          value={name}
          onChange={(event) => setName(event.currentTarget.value.toUpperCase())}
        />
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Reference
        <Input
          aria-label="Reference"
          nativeInput
          disabled={pending}
          maxLength={1024}
          placeholder={chosen.placeholder}
          value={reference}
          onChange={(event) => setReference(event.currentTarget.value)}
        />
      </label>
      <Button
        disabled={pending || name.length === 0 || reference.trim().length === 0}
        size="sm"
        type="submit"
      >
        Add Provider entry
      </Button>
    </form>
  );
}

function FromMainForm(props: {
  readonly vaultName: string;
  readonly mainEntries: ReadonlyArray<VaultEntry>;
  readonly onAdd: (
    kind: "link" | "copy",
    sourceEntryId: VaultEntryId,
    name: string,
    confirmDangerous: boolean,
  ) => Promise<boolean>;
}) {
  const [source, setSource] = useState<string>(props.mainEntries[0]?.id ?? "");
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  // A secret that was deleted meanwhile is no longer a source.
  const sourceEntry = props.mainEntries.find((entry) => entry.id === source);
  const sourceItems = props.mainEntries.map((entry) => ({
    value: entry.id as string,
    label: entry.name,
  }));
  const effectiveName = name.length > 0 ? name : (sourceEntry?.name ?? "");
  const dangerous = isDangerous(effectiveName);
  const add = (kind: "link" | "copy") => {
    if (sourceEntry === undefined) return;
    setPending(true);
    void props
      .onAdd(kind, source as VaultEntryId, name, dangerous && confirmed)
      .then((saved) => {
        if (!saved) return;
        setName("");
        setConfirmed(false);
      })
      .finally(() => setPending(false));
  };
  const disabled = pending || sourceEntry === undefined || (dangerous && !confirmed);
  return (
    <div
      role="group"
      aria-label={`From the Main vault into ${props.vaultName}`}
      className="flex flex-col gap-2 px-4 pb-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
          Main vault secret
          <Select
            disabled={pending}
            items={sourceItems}
            value={sourceEntry === undefined ? null : source}
            onValueChange={(value) => setSource(value ?? "")}
          >
            <SelectTrigger aria-label="Main vault secret">
              <SelectValue placeholder="Choose a secret" />
            </SelectTrigger>
            <SelectPopup>
              {sourceItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
          Name here (optional)
          <Input
            aria-label="Name here"
            nativeInput
            disabled={pending}
            maxLength={128}
            value={name}
            onChange={(event) => setName(event.currentTarget.value.toUpperCase())}
          />
        </label>
        <Button disabled={disabled} size="sm" variant="outline" onClick={() => add("link")}>
          Add Secret link
        </Button>
        <Button disabled={disabled} size="sm" variant="outline" onClick={() => add("copy")}>
          Add copy
        </Button>
      </div>
      {dangerous ? <ConfirmDangerous checked={confirmed} onChange={setConfirmed} /> : null}
    </div>
  );
}

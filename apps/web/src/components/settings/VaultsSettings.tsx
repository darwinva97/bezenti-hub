import { useAtomValue } from "@effect/atom-react";
import {
  IDENTITY_TTL_DEFAULT_SECONDS,
  IDENTITY_TTL_MAX_SECONDS,
  IDENTITY_TTL_MIN_SECONDS,
  type EnvironmentId,
  looksLikeCredential,
  parseTemplate,
  previewTemplate,
  secretNameRisk,
  templateNames,
  templatePathNames,
  type VaultEntry,
  type VaultEntryClass,
  type VaultEntryDelivery,
  type SecretProviderId,
  type VaultProviderScopes,
  type VaultGroupListResult,
  type VaultGroupSummary,
} from "@t3tools/contracts";
import {
  entryActions,
  loadVaultOverview,
  MAKE_SECRET_WARNING,
  VAULT_ENTRY_TYPE_HINT,
  vaultActions,
  vaultOwnerLine,
  type VaultOwnerSection,
  vaultSections,
} from "@t3tools/client-runtime/vaults";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { isElectron } from "../../env";
import { errorMessageOf } from "../../lib/errorMessage";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SecretValueArea } from "./SecretValueArea";
import { peekKeycloakStepUp } from "../auth/keycloakStepUp";
import { LendVaultGroupDialog } from "./LendVaultGroupDialog";
import { MigratedVaultLoansReview } from "./MigratedLoansReview";
import { borrowedInScope, ownerInScope, type OwnedResourceScope } from "./ownedResourceScope";
import { SpaceDefaultVaults } from "./VaultChoices";
import { settle } from "./vaultCommands";

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
        : "It changes how the agent's tools run or whom they trust: only the Owner sets it, or a User in their own Vault.";
    default:
      return null;
  }
};
const isDangerous = (name: string) => secretNameRisk(name) === "dangerous";

const CREDENTIAL_WARNING =
  "This looks like a credential. A Variable's value is shown to everyone who sees it and never masked: make it a Secret unless it is meant to be seen.";

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
  none: "Only templates of this group use it: no process gets it by itself.",
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

/** What a change to an entry sends, besides its name: a value, a class, its delivery. */
interface EntryChange {
  readonly value?: string;
  readonly class?: VaultEntryClass;
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
type ValueMode = "replace" | "make-variable";
const VALUE_MODE_LABEL: Record<ValueMode, string> = {
  replace: "Save value",
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
    dismissUnlinked: useAtomCommand(
      serverEnvironment.dismissUnlinkedVaultEntries,
      "dismiss the unlinked notice",
    ),
  };
}
type VaultCommands = ReturnType<typeof useVaultCommands>;

/**
 * Settings → Vaults (owned-resources 03): a section per owner («Mine», each Organization), each a
 * Vault of groups, `default` first. No Secret's value is ever shown; Variables' are, Guests
 * excepted. See docs/internals/secrets.md.
 */
export function VaultsSettings({ scope }: { readonly scope?: OwnedResourceScope }) {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : <VaultsPage environmentId={environmentId} scope={scope} />}
    </SettingsPageContainer>
  );
}

function VaultsPage({
  environmentId,
  scope,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: OwnedResourceScope | undefined;
}) {
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const userId = session.data?.authenticated === true ? (session.data.userId ?? null) : null;
  const commands = useVaultCommands();
  // The session may change secrets at all (access:write); each group then says what is allowed.
  const mayWrite = useAtomValue(serverEnvironment.putVaultEntry.permissionAtom(environmentId));
  const mayCreate = useAtomValue(serverEnvironment.createVault.permissionAtom(environmentId));
  const [listed, setListed] = useState<VaultGroupListResult | null>(null);
  const [entries, setEntries] = useState<Readonly<Record<string, ReadonlyArray<VaultEntry>>>>({});
  const [error, setError] = useState<string | null>(null);

  const listVaults = () => settle(commands.list({ environmentId, input: {} }));
  const listEntries = (vaultId: VaultGroupSummary["id"]) =>
    settle(commands.entries({ environmentId, input: { vaultId } })).then(
      (result) => [vaultId, result.entries] as const,
    );

  /** Every group the User sees, their names read in parallel. */
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
        setListed(loaded.listed);
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

  /** After a change: the list (counts) and the one group that changed; every group for `all`. */
  const refresh = async (changed: VaultGroupSummary["id"] | "all") => {
    try {
      const next = await listVaults();
      const targets =
        changed === "all"
          ? next.groups.map((group) => group.id)
          : next.groups.filter((group) => group.id === changed).map((group) => group.id);
      const loaded = await Promise.all(targets.map(listEntries));
      setListed(next);
      setEntries((previous) => ({ ...previous, ...Object.fromEntries(loaded) }));
      setError(null);
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not read the Vaults."));
    }
  };

  // Under a scope (a modal section) only that owner's Vault; without one, every owner's. A group
  // lent to a Space (Grants ticket 07) is shown with that Space, read-only, not with its owner.
  const own =
    listed === null
      ? null
      : { ...listed, groups: listed.groups.filter((group) => group.borrowed === undefined) };
  const sections = (own === null ? [] : vaultSections(own, { userId })).filter(
    (section) => scope === undefined || ownerInScope(scope, section.owner, userId),
  );
  const borrowed = (listed?.groups ?? []).filter(
    (group) =>
      group.borrowed !== undefined &&
      (scope === undefined || borrowedInScope(scope, group.borrowed.spaceId, userId)),
  );

  return (
    <>
      <SettingsSection id="vaults" title="Vault">
        <SettingsRow
          title="Secrets for your agents"
          description="A group is a named set of Variables and Secrets for your agents. The Default group goes to every Thread of its Space; you can add named groups per Space or Project. A Variable is configuration: everyone who can see it reads its value, except Guests. A Secret is never shown again once saved, not even to the Owner. It can only be replaced or deleted."
          status={
            error === null ? null : (
              <span className="text-destructive" role="alert">
                {error}
              </span>
            )
          }
        />
        {listed !== null && listed.unlinked.length > 0 ? (
          <UnlinkedNotice
            entries={listed.unlinked}
            onDismiss={async () => {
              await settle(commands.dismissUnlinked({ environmentId, input: {} }));
              await refresh("all");
            }}
          />
        ) : null}
      </SettingsSection>
      {listed === null ? null : sections.length === 0 && borrowed.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">No Vault is shared with you.</p>
      ) : (
        sections.map((section) => (
          <OwnerVault
            key={section.owner.kind === "user" ? section.owner.userId : section.owner.spaceId}
            section={section}
            environmentId={environmentId}
            commands={commands}
            mayWrite={mayWrite}
            mayCreate={mayCreate}
            isOwner={isOwner}
            userId={userId}
            entries={entries}
            onChanged={refresh}
          />
        ))
      )}
      {borrowed.length === 0 ? null : (
        <SettingsSection id="vaults-borrowed" title="Lent to this Space">
          <SettingsRow
            title={`${borrowed.length} ${borrowed.length === 1 ? "group" : "groups"} lent here`}
            description="Other people's groups, read-only here: Variables show their value, Secrets only their name. Choose them as defaults or per Project, like the Space's own."
          />
        </SettingsSection>
      )}
      {borrowed.map((group) => (
        <VaultSection
          key={group.id}
          environmentId={environmentId}
          commands={commands}
          vault={group}
          mayWrite={mayWrite}
          isOwner={isOwner}
          userId={userId}
          entries={entries[group.id] ?? []}
          onChanged={(all) => refresh(all ? "all" : group.id)}
        />
      ))}
      {isOwner && scope?.kind !== "organization" ? (
        <MigratedVaultLoansReview environmentId={environmentId} />
      ) : null}
      {scope?.kind === "user" ? null : (
        <SpaceDefaultVaults
          environmentId={environmentId}
          {...(scope === undefined ? {} : { spaceId: scope.spaceId })}
        />
      )}
    </>
  );
}

/**
 * Owned-resources 03: the entries that were Secret links are independent Secrets now; told once to
 * the Owner, until dismissed.
 */
function UnlinkedNotice(props: {
  readonly entries: VaultGroupListResult["unlinked"];
  readonly onDismiss: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <SettingsRow
      title="Secret links are now independent"
      description={`Rotating the original no longer changes these: ${props.entries
        .map(
          (entry) =>
            `${entry.vaultName ?? "a group"} → ${entry.name}${entry.originalName === null ? "" : ` (was ${entry.originalName})`}`,
        )
        .join(", ")}.`}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void props.onDismiss().finally(() => setPending(false));
          }}
        >
          Got it
        </Button>
      }
    />
  );
}

/** One owner's Vault: its groups, `default` first, and a form for a new group where allowed. */
function OwnerVault(props: {
  readonly section: VaultOwnerSection;
  readonly environmentId: EnvironmentId;
  readonly commands: VaultCommands;
  readonly mayWrite: boolean;
  readonly mayCreate: boolean;
  readonly isOwner: boolean;
  readonly userId: string | null;
  readonly entries: Readonly<Record<string, ReadonlyArray<VaultEntry>>>;
  readonly onChanged: (changed: VaultGroupSummary["id"] | "all") => Promise<void>;
}) {
  const { section, commands, environmentId } = props;
  return (
    <>
      <SettingsSection
        id={`vault-owner-${section.owner.kind === "user" ? section.owner.userId : section.owner.spaceId}`}
        title={section.mine ? "Groups" : section.name}
      >
        {section.canCreate && props.mayCreate ? (
          <NewGroupForm
            ownerName={section.mine ? "your Vault" : `${section.name}'s Vault`}
            onCreate={async (name) => {
              await settle(
                commands.create({ environmentId, input: { name, owner: section.owner } }),
              );
              await props.onChanged("all");
            }}
          />
        ) : (
          <SettingsRow
            title={`${section.groups.length} ${section.groups.length === 1 ? "group" : "groups"}`}
            description={section.mine ? "Your own Vault." : `${section.name}'s Vault.`}
          />
        )}
      </SettingsSection>
      {section.groups.map((group) => (
        <VaultSection
          key={group.id}
          environmentId={environmentId}
          commands={commands}
          vault={group}
          mayWrite={props.mayWrite}
          isOwner={props.isOwner}
          userId={props.userId}
          entries={props.entries[group.id] ?? []}
          onChanged={(all) => props.onChanged(all ? "all" : group.id)}
        />
      ))}
    </>
  );
}

function NewGroupForm(props: {
  readonly ownerName: string;
  readonly onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void props
          .onCreate(name.trim())
          .then(
            () => setName(""),
            (cause: unknown) => setError(errorMessageOf(cause, "Could not create the group.")),
          )
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        {`New group in ${props.ownerName}`}
        <Input
          aria-label="Group name"
          nativeInput
          disabled={pending}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <Button disabled={pending || name.trim().length === 0} size="sm" type="submit">
        Create group
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

/** A group's name as shown: the stored `default` reads as "Default group". Display only. */
const groupLabel = (group: Pick<VaultGroupSummary, "name" | "isDefault">) =>
  group.isDefault ? "Default group" : group.name;

/** The line under a group: whose Vault it is, and for the default group which Space receives it. */
function defaultGroupLine(group: VaultGroupSummary, userId: string | null): string {
  const whose = vaultOwnerLine({ ...group, isDefault: false }, { userId });
  if (!group.isDefault) return whose;
  const owner = group.ownerName ?? "A removed owner";
  const space =
    group.owner.kind === "organization"
      ? owner
      : group.owner.userId === userId
        ? "your Personal space"
        : `${owner}'s Personal space`;
  return `${whose}. Every Thread in ${space} receives this group`;
}

function VaultSection(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: VaultCommands;
  readonly vault: VaultGroupSummary;
  readonly mayWrite: boolean;
  readonly isOwner: boolean;
  readonly userId: string | null;
  readonly entries: ReadonlyArray<VaultEntry>;
  readonly onChanged: (all: boolean) => Promise<void>;
}) {
  const { vault, commands, environmentId } = props;
  const canEdit = vaultActions(vault, { mayWrite: props.mayWrite, surface: VAULT_SURFACE }).add;
  // Grants ticket 07: a named group its managers lend to another Space.
  const mayLend =
    props.mayWrite &&
    vault.canManage &&
    !vault.isDefault &&
    !vault.archived &&
    vault.borrowed === undefined;
  // Back from «Confirm with Keycloak», the Lend dialog it left opens again to finish.
  const [lending, setLending] = useState(() => {
    const back = peekKeycloakStepUp("lend-vault-group");
    return back !== null && !back.fromReview && back.group.id === vault.id;
  });
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
      ? `${name} ${verb}. No template of this group uses it yet, so no process gets it.`
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
              ? "is now a Secret; what was already printed in the history stays visible"
              : "replaced";
      return savedMessage(entry.name, verb, result.warnings);
    });
  const owner =
    vault.borrowed === undefined
      ? defaultGroupLine(vault, props.userId)
      : `Lent to ${vault.borrowed.spaceName} by ${vault.borrowed.lenderName ?? "its owner"}, read-only here`;
  // A name that changes how tools run: the Owner's, and a User's in their own Vault (04).
  const confirmsDangerous =
    props.isOwner || (vault.owner.kind === "user" && vault.owner.userId === props.userId);
  return (
    <SettingsSection id={`vault-${vault.id}`} title={groupLabel(vault)}>
      <SettingsRow
        title={`${vault.entryCount} ${vault.entryCount === 1 ? "secret" : "secrets"}`}
        description={`${owner}.${vault.archived ? " Archived." : ""}${canEdit ? " You can add, replace and delete secrets, never see them." : ""}`}
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
          // `default` is never deleted: the Hub says so with `canManage`.
          vault.canManage && props.mayWrite ? (
            <div className="flex gap-1">
              {mayLend ? (
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`Lend group ${vault.name}`}
                  onClick={() => setLending(true)}
                >
                  Lend…
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                aria-label={`Delete group ${vault.name}`}
                onClick={() => {
                  if (!window.confirm(`Delete the group ${vault.name} and its secrets?`)) return;
                  void act(async () => {
                    await settle(commands.remove({ environmentId, input: { vaultId: vault.id } }));
                    return null;
                  }, true);
                }}
              >
                Delete group
              </Button>
            </div>
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
            isOwner={confirmsDangerous}
            entry={entry}
            onChange={(input) => change(entry, input)}
            onDelete={() =>
              act(async () => {
                const input = { vaultId: vault.id, entryId: entry.id };
                await settle(commands.deleteEntry({ environmentId, input }));
                return null;
              })
            }
          />
        ))}
      </ul>
      {canEdit ? (
        <AddSecretForm
          vaultName={vault.name}
          isOwner={props.isOwner}
          confirmsDangerous={confirmsDangerous}
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
      {lending ? (
        <LendVaultGroupDialog
          group={{ id: vault.id, name: vault.name }}
          onClose={() => setLending(false)}
        />
      ) : null}
    </SettingsSection>
  );
}

function EntryRow(props: {
  readonly vault: VaultGroupSummary;
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
        <Badge variant="outline">{isVariable ? "Variable" : "Secret"}</Badge>
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
                if (!window.confirm(MAKE_SECRET_WARNING(entry.name))) return;
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
          {mode === "make-variable" ? (
            <span className="text-xs text-muted-foreground">
              A Secret's value is never shown: a Variable takes a new one, visible to everyone who
              sees it.
            </span>
          ) : null}
          <div className="flex items-start gap-2">
            <SecretValueArea
              aria-label={`New value of ${entry.name}`}
              visible={shownAsTyped}
              value={value}
              onValueChange={setValue}
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
    </li>
  );
}

function AddSecretForm(props: {
  readonly vaultName: string;
  readonly isOwner: boolean;
  /** The Owner, or a User in their own Vault (owned-resources 04). */
  readonly confirmsDangerous: boolean;
  readonly entries: ReadonlyArray<VaultEntry>;
  readonly onAdd: (
    name: string,
    value: string,
    options: {
      readonly kind: AddKind;
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
  const hint = nameHint(name, props.confirmsDangerous);
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
    (dangerous && (!props.confirmsDangerous || !confirmed));
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
            delivery: chosenDelivery,
            confirmDangerous: dangerous && confirmed,
            ...(isIdentity ? { ttlSeconds } : {}),
          })
          .then((saved) => {
            // A failed save keeps what was typed.
            if (!saved) return;
            setName("");
            setValue("");
            setDelivery("env");
            setConfirmed(false);
          })
          .finally(() => setPending(false));
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-36 sm:shrink-0">
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
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
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
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
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
            <label className="flex flex-col gap-1 text-xs font-medium sm:w-28 sm:shrink-0">
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
        ) : null}
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-48 sm:shrink-0">
          Delivery
          <DeliverySelect
            label="Delivery"
            value={chosenDelivery}
            disabled={pending || isIdentity}
            allowNone={!isTemplate && !isIdentity}
            onChange={setDelivery}
          />
        </label>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {isIdentity || isTemplate ? (
          <span className="flex-1" />
        ) : (
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
            Value
            <SecretValueArea
              aria-label="Value"
              className="[&_textarea]:min-h-8.5 sm:[&_textarea]:min-h-7.5"
              disabled={pending}
              visible={isVariable}
              value={value}
              onValueChange={setValue}
            />
          </label>
        )}
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
      {kind === "secret" || kind === "variable" ? (
        <span className="text-xs text-muted-foreground">{VAULT_ENTRY_TYPE_HINT[kind]}</span>
      ) : null}
      {isVariable ? <CredentialWarning name={name} value={value} /> : null}
      {hint === null ? null : <span className="text-xs text-destructive">{hint}</span>}
      {dangerous && props.confirmsDangerous ? (
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
  readonly vaultId: VaultGroupSummary["id"];
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
  const fetchChoices = useEffectEvent((vaultId: VaultGroupSummary["id"]) =>
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

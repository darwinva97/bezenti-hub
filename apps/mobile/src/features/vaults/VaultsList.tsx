import { useAtomValue } from "@effect/atom-react";
import {
  entryActions,
  entryBadges,
  loadVaultOverview,
  VAULT_ENTRY_TYPE_HINT,
  vaultFailureMessage,
  vaultOwnerLine,
} from "@t3tools/client-runtime/vaults";
import { secretRequestVaultNameProblem } from "@t3tools/client-runtime/secret-request";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  VaultEntry,
  VaultEntryClass,
  VaultGroupSummary,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SecretValueInput } from "./SecretValueInput";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { serverEnvironment } from "../../state/server";
import { useSpaceSelections } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";

const SURFACE = "mobile";

async function settle<A, E>(pending: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Success") return result.value;
  throw new Error(vaultFailureMessage(squashAtomCommandFailure(result)));
}

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "That did not work.";

/**
 * Settings → Vaults on a phone: each owner's Vault by group (owned-resources 03) and the names in
 * them; whoever edits a group adds or replaces a value. Never a Secret's value on screen (nobody reads one back), never
 * the master key: that stays on web and desktop (spec 5, «Clientes»). The Hub decides again on
 * every call.
 */
export function VaultsList(props: { readonly environmentId: EnvironmentId }) {
  return <VaultsPage key={props.environmentId} environmentId={props.environmentId} />;
}

function VaultsPage(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const selections = useSpaceSelections();
  const isOwner = selections.get(environmentId)?.view?.isOwner === true;
  const mayWrite = useAtomValue(serverEnvironment.putVaultEntry.permissionAtom(environmentId));
  const list = useAtomCommand(serverEnvironment.listVaults, "list Vaults");
  const entries = useAtomCommand(serverEnvironment.listVaultEntries, "list a Vault's secrets");
  const put = useAtomCommand(serverEnvironment.putVaultEntry, {
    label: "save a secret",
    reportFailure: false,
    reportDefect: false,
  });
  const [loaded, setLoaded] = useState<{
    readonly vaults: ReadonlyArray<VaultGroupSummary>;
    readonly entries: Readonly<Record<string, ReadonlyArray<VaultEntry>>>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchAll = useEffectEvent((target: EnvironmentId) =>
    loadVaultOverview({
      list: () => settle(list({ environmentId: target, input: {} })),
      entries: (vaultId) => settle(entries({ environmentId: target, input: { vaultId } })),
    }),
  );
  const refresh = async () => {
    try {
      setLoaded(await fetchAll(environmentId));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Vaults this User sees from the Hub when the page opens.
  useEffect(() => {
    let cancelled = false;
    void fetchAll(environmentId).then(
      (overview) => {
        if (!cancelled) setLoaded(overview);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const save = async (
    vault: VaultGroupSummary,
    input: {
      readonly entryId?: VaultEntry["id"];
      readonly name: string;
      readonly value: string;
      readonly class?: VaultEntryClass;
    },
  ) => {
    const result = await settle(
      put({
        environmentId,
        input: {
          vaultId: vault.id,
          ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
          name: input.name,
          value: Redacted.make(input.value),
          ...(input.class === undefined ? {} : { class: input.class }),
        },
      }),
    );
    await refresh();
    return result.warnings.includes("short-value")
      ? `${input.name} saved. Shorter than 6 characters: it won't be masked in the history.`
      : `${input.name} saved.`;
  };

  return (
    <View className="gap-6">
      {error === null ? null : (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      {loaded === null ? (
        error === null ? (
          <Text className="px-2 text-sm text-foreground-muted">Loading Vaults…</Text>
        ) : null
      ) : loaded.vaults.length === 0 ? (
        <Text className="px-2 text-sm text-foreground-muted">No Vault is shared with you.</Text>
      ) : (
        loaded.vaults.map((vault) => (
          <VaultCard
            key={vault.id}
            vault={vault}
            entries={loaded.entries[vault.id] ?? []}
            mayWrite={mayWrite}
            isOwner={isOwner}
            onSave={(input) => save(vault, input)}
          />
        ))
      )}
      <Text className="px-2 text-xs text-foreground-muted">
        A Secret's value is never shown again once saved; a Variable's is shown to everyone who
        receives its group. Back up the master key on the web or desktop app.
      </Text>
    </View>
  );
}

function VaultCard(props: {
  readonly vault: VaultGroupSummary;
  readonly entries: ReadonlyArray<VaultEntry>;
  readonly mayWrite: boolean;
  readonly isOwner: boolean;
  readonly onSave: (input: {
    readonly entryId?: VaultEntry["id"];
    readonly name: string;
    readonly value: string;
    readonly class?: VaultEntryClass;
  }) => Promise<string>;
}) {
  const { vault } = props;
  const context = { mayWrite: props.mayWrite, surface: SURFACE, isOwner: props.isOwner } as const;
  const canAdd = entryActions(vault, { kind: "own", name: "NAME" }, context).add;
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<string>) => {
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    }
  };
  return (
    <ListSection
      title={vault.ownerName === null ? vault.name : `${vault.name} · ${vault.ownerName}`}
      footer={`${vaultOwnerLine(vault, { userId: null })}.${vault.archived ? " Archived." : ""}`}
    >
      {props.entries.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">No secrets yet.</Text>
      ) : null}
      {props.entries.map((entry) => (
        <EntryRow
          key={`${entry.id}:${entryActions(vault, entry, context).replace}`}
          entry={entry}
          canReplace={entryActions(vault, entry, context).replace}
          onReplace={(value) =>
            run(() => props.onSave({ entryId: entry.id, name: entry.name, value }))
          }
        />
      ))}
      {canAdd ? (
        <AddSecret
          onAdd={(name, value, entryClass) =>
            run(() => props.onSave({ name, value, class: entryClass }))
          }
        />
      ) : null}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      {notice === null ? null : (
        <Text accessibilityLiveRegion="polite" className="px-4 pb-3 text-sm text-foreground-muted">
          {notice}
        </Text>
      )}
    </ListSection>
  );
}

function EntryRow(props: {
  readonly entry: VaultEntry;
  readonly canReplace: boolean;
  readonly onReplace: (value: string) => Promise<boolean>;
}) {
  const { entry } = props;
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const badges = entryBadges(entry);
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="font-mono text-base text-foreground">{entry.name}</Text>
      {badges.length === 0 ? null : (
        <Text className="text-xs text-foreground-muted">{badges.join(" · ")}</Text>
      )}
      {entry.description === null || entry.description.length === 0 ? null : (
        <Text className="text-sm text-foreground-muted">{entry.description}</Text>
      )}
      {/* A Variable is configuration: its value, as the Hub gives it (Guests never). */}
      {entry.class === "variable" && entry.value !== undefined ? (
        <Text
          selectable
          accessibilityLabel={`Value of ${entry.name}`}
          className="font-mono text-sm text-foreground"
        >
          {entry.value}
        </Text>
      ) : null}
      {props.canReplace && !replacing ? (
        <Button
          label="Replace value"
          accessibilityLabel={`Replace value of ${entry.name}`}
          size="compact"
          onPress={() => setReplacing(true)}
        />
      ) : null}
      {replacing ? (
        <View className="gap-2">
          <SecretValueInput
            accessibilityLabel={`New value for ${entry.name}`}
            placeholder="New value"
            value={value}
            onChangeText={setValue}
            editable={!pending}
            visible={entry.class === "variable"}
          />
          <View className="flex-row gap-2">
            <Button
              label="Save"
              accessibilityLabel={`Save new value for ${entry.name}`}
              tone="primary"
              size="compact"
              disabled={pending || value.length === 0}
              onPress={() => {
                setPending(true);
                void props
                  .onReplace(value)
                  .then((saved) => {
                    if (!saved) return;
                    setValue("");
                    setReplacing(false);
                  })
                  .finally(() => setPending(false));
              }}
            />
            <Button
              label="Cancel"
              tone="text"
              size="compact"
              disabled={pending}
              onPress={() => {
                setValue("");
                setReplacing(false);
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function AddSecret(props: {
  readonly onAdd: (name: string, value: string, entryClass: VaultEntryClass) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [variable, setVariable] = useState(false);
  const [pending, setPending] = useState(false);
  if (!open) {
    return (
      <View className="px-4 py-3">
        <Button label="Add secret" size="compact" onPress={() => setOpen(true)} />
      </View>
    );
  }
  const trimmed = name.trim();
  const problem = trimmed.length === 0 ? null : secretRequestVaultNameProblem(trimmed);
  const close = () => {
    setName("");
    setValue("");
    setVariable(false);
    setOpen(false);
  };
  const entryClass: VaultEntryClass = variable ? "variable" : "secret";
  return (
    <View className="gap-2 px-4 py-3">
      <TextInput
        accessibilityLabel="Secret name"
        placeholder="NAME"
        value={name}
        onChangeText={(text) => setName(text.toUpperCase())}
        editable={!pending}
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
      />
      {problem === null ? null : <Text className="text-xs text-danger-foreground">{problem}</Text>}
      <ListToggleRow
        label="Variable"
        value={variable}
        disabled={pending}
        onValueChange={setVariable}
      />
      <Text className="text-xs text-foreground-muted">{VAULT_ENTRY_TYPE_HINT[entryClass]}</Text>
      <SecretValueInput
        accessibilityLabel="Secret value"
        placeholder="Value"
        value={value}
        onChangeText={setValue}
        editable={!pending}
        visible={variable}
      />
      <View className="flex-row gap-2">
        <Button
          label={variable ? "Save variable" : "Save secret"}
          accessibilityLabel="Save secret"
          tone="primary"
          size="compact"
          disabled={pending || trimmed.length === 0 || problem !== null || value.length === 0}
          onPress={() => {
            setPending(true);
            void props
              .onAdd(trimmed, value, entryClass)
              .then((saved) => {
                if (saved) close();
              })
              .finally(() => setPending(false));
          }}
        />
        <Button label="Cancel" tone="text" size="compact" disabled={pending} onPress={close} />
      </View>
    </View>
  );
}

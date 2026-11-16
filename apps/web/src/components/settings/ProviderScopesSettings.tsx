import type {
  EnvironmentId,
  ProviderEntryBreak,
  ProviderScope,
  ProviderScopeId,
  SecretProviderCheck,
  SecretProviderConfig,
  SecretProviderId,
  VaultId,
  VaultSummary,
} from "@t3tools/contracts";
import { MAIN_VAULT_ID } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { settle } from "./vaultCommands";

// Vaults ticket 03: Provider scopes (the Owner's). A scope names what a Vault may read through a
// provider: its role and path prefixes. Admins add Provider entries only through one.

const CHECK_LABEL: Record<NonNullable<SecretProviderCheck["error"]>, string> = {
  forbidden: "refused",
  "not-found": "nothing at the path",
  unavailable: "did not answer",
  invalid: "not readable here",
};

/** A test's outcome in words: never a value, only whether it worked. */
export const checkText = (label: string, check: SecretProviderCheck) =>
  check.ok ? `${label}: ok` : `${label}: ${CHECK_LABEL[check.error ?? "invalid"]}`;

const breaksText = (breaks: ReadonlyArray<ProviderEntryBreak>) =>
  breaks.map((entry) => `${entry.vaultName} → ${entry.name}`).join(", ");

/** Asks before a change that breaks entries; resolves whether to go on. */
const confirmBreaks = (what: string, breaks: ReadonlyArray<ProviderEntryBreak>) =>
  breaks.length === 0 ||
  window.confirm(
    `${what} breaks these Provider entries (they stop being delivered): ${breaksText(breaks)}. Go on?`,
  );

interface Draft {
  readonly scopeId?: ProviderScopeId;
  readonly providerId: string;
  readonly label: string;
  readonly paths: string;
  readonly role: string;
  readonly mount: string;
  readonly namespace: string;
  readonly probe: string;
  readonly writable: boolean;
}

const emptyDraft = (providerId: string): Draft => ({
  providerId,
  label: "",
  paths: "",
  role: "",
  mount: "",
  namespace: "",
  probe: "",
  writable: false,
});

const draftOf = (scope: ProviderScope): Draft => ({
  scopeId: scope.id,
  providerId: scope.providerId,
  label: scope.label,
  paths: scope.allowedPaths.join("\n"),
  role: scope.auth.role ?? "",
  mount: scope.auth.mount ?? "",
  namespace: scope.auth.namespace ?? "",
  probe: scope.probeReference ?? "",
  writable: scope.writable,
});

export function ProviderScopesSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: Readonly<Record<string, SecretProviderConfig>>;
}) {
  const { environmentId } = props;
  const list = useAtomCommand(serverEnvironment.listProviderScopes, "list provider scopes");
  const listVaults = useAtomCommand(serverEnvironment.listVaults, "list Vaults");
  const put = useAtomCommand(serverEnvironment.putProviderScope, "save a provider scope");
  const remove = useAtomCommand(serverEnvironment.deleteProviderScope, "delete a provider scope");
  const allow = useAtomCommand(serverEnvironment.allowProviderScope, "allow a provider scope");
  const test = useAtomCommand(serverEnvironment.testSecretProvider, "test a provider scope");
  const [scopes, setScopes] = useState<ReadonlyArray<ProviderScope> | null>(null);
  const [vaults, setVaults] = useState<ReadonlyArray<VaultSummary>>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerIds = Object.keys(props.providers);

  /** The scopes and the Vaults to allow them to; nothing for anyone but the Owner. */
  const fetchScopes = useEffectEvent(async (target: EnvironmentId) => {
    try {
      const [scopesAnswer, vaultsAnswer] = await Promise.all([
        settle(list({ environmentId: target, input: {} })),
        settle(listVaults({ environmentId: target, input: {} })),
      ]);
      return {
        scopes: scopesAnswer.scopes,
        vaults: vaultsAnswer.vaults.filter((vault) => vault.id !== MAIN_VAULT_ID),
      };
    } catch {
      return null;
    }
  });
  const show = (loaded: Awaited<ReturnType<typeof fetchScopes>>) => {
    setScopes(loaded?.scopes ?? null);
    setVaults(loaded?.vaults ?? []);
  };
  const load = () => fetchScopes(environmentId).then(show);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Hub's provider scopes and Vaults when the panel opens.
  useEffect(() => {
    let cancelled = false;
    void fetchScopes(environmentId).then((loaded) => {
      if (cancelled) return;
      setScopes(loaded?.scopes ?? null);
      setVaults(loaded?.vaults ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const run = async (work: () => Promise<string | null>) => {
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      if (message !== null) setNotice(message);
      await load();
    } catch (cause) {
      setError(errorMessageOf(cause, "That did not work."));
    }
  };

  const save = (current: Draft) =>
    run(async () => {
      const input = {
        ...(current.scopeId === undefined ? {} : { scopeId: current.scopeId }),
        providerId: current.providerId as SecretProviderId,
        label: current.label.trim(),
        auth: Object.fromEntries(
          (
            [
              ["role", current.role],
              ["mount", current.mount],
              ["namespace", current.namespace],
            ] as const
          ).filter(([, value]) => value.trim().length > 0),
        ),
        allowedPaths: current.paths
          .split("\n")
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
        writable: current.writable,
        probeReference: current.probe.trim().length === 0 ? null : current.probe.trim(),
      };
      const asked = await settle(put({ environmentId, input }));
      if (asked.scope === null) {
        if (!confirmBreaks("Narrowing this scope", asked.breaks)) return null;
        await settle(put({ environmentId, input: { ...input, confirm: true } }));
      }
      setDraft(null);
      return `Saved ${input.label}.`;
    });

  const setAllowed = (scope: ProviderScope, vaultId: VaultId, allowed: boolean) =>
    run(async () => {
      const input = { scopeId: scope.id, vaultId, allowed };
      const asked = await settle(allow({ environmentId, input }));
      if (asked.scope === null) {
        if (!confirmBreaks("Taking this scope back", asked.breaks)) return null;
        await settle(allow({ environmentId, input: { ...input, confirm: true } }));
      }
      return null;
    });

  const removeScope = (scope: ProviderScope) =>
    run(async () => {
      const asked = await settle(remove({ environmentId, input: { scopeId: scope.id } }));
      if (asked.deleted) return `Deleted ${scope.label}.`;
      if (!confirmBreaks(`Deleting ${scope.label}`, asked.breaks)) return null;
      await settle(remove({ environmentId, input: { scopeId: scope.id, confirm: true } }));
      return `Deleted ${scope.label}.`;
    });

  const testScope = (scope: ProviderScope) =>
    run(async () => {
      const result = await settle(
        test({ environmentId, input: { providerId: scope.providerId, scopeId: scope.id } }),
      );
      return [
        checkText("Sign-in", result.auth),
        ...(result.probe === undefined ? [] : [checkText("Probe path", result.probe)]),
      ].join(" · ");
    });

  if (scopes === null) return null;
  return (
    <SettingsSection
      title="Provider scopes"
      headerAction={
        providerIds.length > 0 ? (
          <Button size="xs" variant="outline" onClick={() => setDraft(emptyDraft(providerIds[0]!))}>
            Add scope
          </Button>
        ) : null
      }
    >
      <SettingsRow
        title="What each Vault may read"
        description="A scope signs in with its own provider role and allows only the path prefixes listed. An Organization's Admins add Provider entries only through a scope allowed to their Vault."
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
      />
      {scopes.map((scope) => (
        <SettingsRow
          key={scope.id}
          title={
            <span className="flex items-center gap-2">
              {scope.label}
              {scope.providerLabel === null ? <Badge variant="destructive">broken</Badge> : null}
            </span>
          }
          description={
            <span className="flex flex-col gap-1">
              <span>
                {scope.providerLabel ?? scope.providerId}: {scope.allowedPaths.join(", ")}
              </span>
              <span className="flex flex-wrap gap-2">
                {vaults.map((vault) => {
                  const allowed = scope.vaults.some((item) => item.vaultId === vault.id);
                  return (
                    <label key={vault.id} className="flex items-center gap-1 text-xs">
                      <Checkbox
                        aria-label={`Allow ${scope.label} to ${vault.name}`}
                        checked={allowed}
                        onCheckedChange={(checked) =>
                          void setAllowed(scope, vault.id, checked === true)
                        }
                      />
                      {vault.name}
                    </label>
                  );
                })}
              </span>
            </span>
          }
          control={
            <span className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => void testScope(scope)}>
                Test connection
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDraft(draftOf(scope))}>
                Edit
              </Button>
              <Button size="xs" variant="ghost" onClick={() => void removeScope(scope)}>
                Delete
              </Button>
            </span>
          }
        />
      ))}
      {draft === null ? null : (
        <ScopeForm
          draft={draft}
          providers={props.providers}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void save(draft)}
        />
      )}
    </SettingsSection>
  );
}

function ScopeForm(props: {
  readonly draft: Draft;
  readonly providers: Readonly<Record<string, SecretProviderConfig>>;
  readonly onChange: (draft: Draft) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const { draft, onChange } = props;
  const items = Object.entries(props.providers).map(([id, config]) => ({
    value: id,
    label: config.label,
  }));
  const field = (name: keyof Draft, label: string, placeholder = "") => (
    <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
      {label}
      <Input
        aria-label={label}
        nativeInput
        placeholder={placeholder}
        value={String(draft[name] ?? "")}
        onChange={(event) => onChange({ ...draft, [name]: event.currentTarget.value })}
      />
    </label>
  );
  return (
    <form
      aria-label={draft.scopeId === undefined ? "Add a provider scope" : `Edit ${draft.label}`}
      className="flex flex-col gap-2 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-48">
          Provider
          <Select
            items={items}
            value={draft.providerId}
            onValueChange={(value) => onChange({ ...draft, providerId: value ?? draft.providerId })}
          >
            <SelectTrigger aria-label="Provider">
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
        {field("label", "Scope name", "Acme production")}
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Allowed path prefixes (one per line)
        <Textarea
          aria-label="Allowed path prefixes"
          value={draft.paths}
          placeholder="kv/acme"
          onChange={(event) => onChange({ ...draft, paths: event.currentTarget.value })}
        />
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        {field("role", "Role", "acme-reader")}
        {field("mount", "Mount", "kv")}
        {field("namespace", "Namespace")}
      </div>
      {field("probe", "Probe path for «Test connection» (inside the prefixes)", "kv/acme/probe#ok")}
      <label className="flex items-center gap-2 text-xs font-medium">
        <Checkbox
          aria-label="Writable"
          checked={draft.writable}
          onCheckedChange={(checked) => onChange({ ...draft, writable: checked === true })}
        />
        Writable (the Hub may write values through this scope)
      </label>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={draft.label.trim().length === 0}>
          Save scope
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

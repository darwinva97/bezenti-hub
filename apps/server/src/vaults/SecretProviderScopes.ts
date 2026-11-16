/**
 * Provider scopes and «Test connection» (Vaults ticket 03): the Owner's, decided by AccessPolicy
 * `secretProvider.manage`. A change that would break Provider entries lists them and changes
 * nothing until confirmed; after it they are «broken». Never a value nor a credential, anywhere.
 */
import {
  MAIN_VAULT_ID,
  PROVIDER_SCOPE_AUTH_FIELDS,
  type ProviderEntryBreak,
  type ProviderScope,
  type ProviderScopeAllowInput,
  type ProviderScopeChangeResult,
  type ProviderScopeDeleteInput,
  type ProviderScopeDeleteResult,
  ProviderScopeId,
  type ProviderScopePutInput,
  type ProviderScopesListResult,
  type SecretProviderId,
  type SecretProviderImpact,
  type SecretProviderImpactInput,
  SecretProviderScopeError,
  type SecretProviderTestInput,
  type SecretProviderTestResult,
  type ServerSettings,
  type SpaceId,
  type UserId,
  VaultEntryId,
  VaultId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { authOf, pathsOf, prefixAllows } from "./providerScopeRules.ts";
import * as ProviderReads from "./ProviderReads.ts";

export class SecretProviderScopes extends Context.Service<
  SecretProviderScopes,
  {
    readonly list: Effect.Effect<ProviderScopesListResult, SecretProviderScopeError>;
    readonly put: (
      input: ProviderScopePutInput,
    ) => Effect.Effect<ProviderScopeChangeResult, SecretProviderScopeError>;
    readonly remove: (
      input: ProviderScopeDeleteInput,
    ) => Effect.Effect<ProviderScopeDeleteResult, SecretProviderScopeError>;
    readonly allow: (
      input: ProviderScopeAllowInput,
    ) => Effect.Effect<ProviderScopeChangeResult, SecretProviderScopeError>;
    readonly test: (
      input: SecretProviderTestInput,
    ) => Effect.Effect<SecretProviderTestResult, SecretProviderScopeError>;
    readonly impact: (
      input: SecretProviderImpactInput,
    ) => Effect.Effect<SecretProviderImpact, SecretProviderScopeError>;
    /**
     * After the Owner changed `settings.secretProviders`: audited `secret_provider.*` with the
     * kind and the names of the fields that changed, never a value (credentials are sealed).
     */
    readonly recordProviderChanges: (
      before: ServerSettings["secretProviders"],
      after: ServerSettings["secretProviders"],
    ) => Effect.Effect<void>;
  }
>()("t3/vaults/SecretProviderScopes") {}

const fail = (reason: SecretProviderScopeError["reason"], message: string) =>
  Effect.fail(new SecretProviderScopeError({ reason, message }));

const AUTH_FIELDS: ReadonlySet<string> = new Set(PROVIDER_SCOPE_AUTH_FIELDS);

interface ScopeRow {
  readonly scopeId: string;
  readonly providerId: string;
  readonly label: string;
  readonly auth: string;
  readonly paths: string;
  readonly writable: number;
  readonly probeReference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const SCOPE_COLUMNS = `
  scope_id AS "scopeId", provider_id AS "providerId", label, auth_json AS "auth",
  allowed_paths_json AS "paths", writable, probe_reference AS "probeReference",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

interface EntryRow {
  readonly vaultId: string;
  readonly vaultName: string;
  readonly entryId: string;
  readonly name: string;
  readonly reference: string;
  readonly providerId: string;
}

const breakOf = (row: EntryRow): ProviderEntryBreak => ({
  vaultId: VaultId.make(row.vaultId),
  vaultName: row.vaultName,
  entryId: VaultEntryId.make(row.entryId),
  name: row.name,
});

const isScopeError = Schema.is(SecretProviderScopeError);

/** JSON of what a scope row holds (plain strings and arrays: it cannot throw). */
const toJson = (value: unknown): string => JSON.stringify(value);
/** Whether two config values are the same; compared, never logged. */
const sameValue = (a: unknown, b: unknown): boolean => toJson(a) === toJson(b);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const reads = yield* ProviderReads.ProviderReads;
  const random = yield* SecureRandom.SecureRandom;

  const storage = (what: string) => (cause: unknown) =>
    isScopeError(cause)
      ? Effect.fail(cause)
      : Effect.logError(`SecretProviderScopes: could not ${what}`, { cause }).pipe(
          Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
        );

  /** The Owner, or a refusal: Secret providers and their scopes are the Installation's. */
  const owner = Effect.gen(function* () {
    const acting = yield* spaces.actingUser.pipe(
      Effect.catchTags({
        SpaceAccessDeniedError: () => fail("forbidden", "Only the Owner manages secret providers."),
        SpaceDirectoryStorageError: storage("read who you are"),
      }),
    );
    if (Option.isNone(acting))
      return yield* fail("forbidden", "Only the Owner manages secret providers.");
    const can = yield* spaces
      .authorizer(acting.value)
      .pipe(Effect.catch(storage("check what you may do")));
    if (!can("secretProvider.manage", AccessPolicy.installation)) {
      return yield* fail("forbidden", "Only the Owner manages secret providers.");
    }
    return acting.value;
  });

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const findScope = (scopeId: string) =>
    sql<ScopeRow>`
      SELECT ${sql.literal(SCOPE_COLUMNS)} FROM secret_provider_scopes WHERE scope_id = ${scopeId}
    `.pipe(
      Effect.catch(storage("read the scope")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? fail("not-found", "That provider scope does not exist.")
          : Effect.succeed(rows[0]),
      ),
    );

  /** The Provider entries reading through a scope, optionally in one Vault. */
  const entriesOf = (scopeId: string, vaultId?: string) =>
    sql<EntryRow>`
      SELECT e.vault_id AS "vaultId", v.name AS "vaultName", e.entry_id AS "entryId", e.name AS "name",
        e.provider_reference AS "reference", e.provider_id AS "providerId"
      FROM vault_entries e JOIN vaults v ON v.vault_id = e.vault_id
      WHERE e.kind = 'provider' AND e.provider_scope_id = ${scopeId}
        ${vaultId === undefined ? sql.literal("") : sql`AND e.vault_id = ${vaultId}`}
      ORDER BY v.name, e.name
    `.pipe(Effect.catch(storage("read the scope's entries")));

  const viewOf = Effect.fn("SecretProviderScopes.viewOf")(function* (row: ScopeRow) {
    const vaults = yield* sql<{ readonly vaultId: string; readonly name: string }>`
      SELECT a.vault_id AS "vaultId", v.name AS "name"
      FROM vault_provider_scopes a JOIN vaults v ON v.vault_id = a.vault_id
      WHERE a.scope_id = ${row.scopeId} ORDER BY v.name
    `.pipe(Effect.catch(storage("read the scope's Vaults")));
    const status = yield* reads.status(row.providerId);
    return {
      id: ProviderScopeId.make(row.scopeId),
      providerId: row.providerId as SecretProviderId,
      providerLabel: status.label,
      label: row.label,
      auth: authOf(row.auth),
      allowedPaths: pathsOf(row.paths),
      writable: row.writable === 1,
      probeReference: row.probeReference,
      vaults: vaults.map((vault) => ({ vaultId: VaultId.make(vault.vaultId), name: vault.name })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies ProviderScope;
  });

  const record = (
    userId: UserId,
    action:
      | "secret_provider.create"
      | "secret_provider.update"
      | "secret_provider.delete"
      | "secret_provider.test"
      | "provider_scope.create"
      | "provider_scope.update"
      | "provider_scope.delete"
      | "provider_scope.allow",
    target: {
      readonly kind: "secret_provider" | "provider_scope";
      readonly id: string;
      readonly name: string;
    },
    detail: Readonly<Record<string, string | number | boolean | null>>,
    spaceId: SpaceId | null = null,
  ) =>
    audit
      .record({
        actor: AuditLog.userActor(userId),
        action,
        spaceId,
        target,
        detail,
      } as AuditLog.AuditRecord)
      .pipe(Effect.catch(storage("record the change")));

  /**
   * Why the scope's settings are refused: auth keys outside the allow-list, a path prefix with a
   * path trick, or a probe that its own paths (or its provider) would not read.
   */
  const scopeProblem = Effect.fn("SecretProviderScopes.scopeProblem")(function* (
    input: ProviderScopePutInput,
  ) {
    const unknownAuth = Object.keys(input.auth).filter((key) => !AUTH_FIELDS.has(key));
    if (unknownAuth.length > 0) {
      return `A scope sets only ${PROVIDER_SCOPE_AUTH_FIELDS.join(", ")}; not ${unknownAuth.join(", ")}.`;
    }
    for (const path of input.allowedPaths) {
      const problem = ProviderReads.referencePathProblem(path);
      if (problem !== undefined) return `${path}: ${problem}`;
    }
    if (input.probeReference !== undefined && input.probeReference !== null) {
      const problem = yield* reads.referenceProblem({
        providerId: input.providerId,
        scopeId: null,
        reference: input.probeReference,
      });
      if (problem !== undefined) return `Probe path: ${problem}`;
      if (!prefixAllows(input.allowedPaths, input.probeReference)) {
        return "The probe path must be inside the scope's allowed paths.";
      }
    }
    if ((yield* reads.status(input.providerId)).label === null) {
      return "That secret provider is not connected.";
    }
    return undefined;
  });

  const list = Effect.gen(function* () {
    yield* owner;
    const rows = yield* sql<ScopeRow>`
      SELECT ${sql.literal(SCOPE_COLUMNS)} FROM secret_provider_scopes ORDER BY provider_id, label
    `.pipe(Effect.catch(storage("read the scopes")));
    return { scopes: yield* Effect.forEach(rows, viewOf) };
  }).pipe(Effect.withSpan("SecretProviderScopes.list"));

  const put = Effect.fn("SecretProviderScopes.put")(function* (input: ProviderScopePutInput) {
    const userId = yield* owner;
    const problem = yield* scopeProblem(input);
    if (problem !== undefined) return yield* fail("invalid", problem);
    const at = yield* now;
    const taken = yield* sql<{ readonly scopeId: string }>`
      SELECT scope_id AS "scopeId" FROM secret_provider_scopes
      WHERE provider_id = ${input.providerId} AND label = ${input.label} COLLATE NOCASE
    `.pipe(Effect.catch(storage("read the scopes")));
    if (taken.some((row) => row.scopeId !== input.scopeId)) {
      return yield* fail(
        "duplicate-label",
        `${input.label} already names a scope of that provider.`,
      );
    }
    const values = {
      auth: toJson(input.auth),
      paths: toJson(input.allowedPaths),
      writable: input.writable === true ? 1 : 0,
      probe: input.probeReference ?? null,
    };
    if (input.scopeId === undefined) {
      const scopeId = `scope-${Buffer.from(yield* random.randomBytes(16)).toString("hex")}`;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO secret_provider_scopes (scope_id, provider_id, label, auth_json,
                allowed_paths_json, writable, probe_reference, created_at, updated_at, created_by)
              VALUES (${scopeId}, ${input.providerId}, ${input.label}, ${values.auth}, ${values.paths},
                ${values.writable}, ${values.probe}, ${at}, ${at}, ${userId})
            `;
            yield* record(
              userId,
              "provider_scope.create",
              { kind: "provider_scope", id: scopeId, name: input.label },
              {
                provider: input.providerId,
                paths: input.allowedPaths.length,
                writable: values.writable === 1,
              },
            );
          }),
        )
        .pipe(Effect.catch(storage("add the scope")));
      return { scope: yield* viewOf(yield* findScope(scopeId)), breaks: [] };
    }
    const before = yield* findScope(input.scopeId);
    // What the new paths (or provider) would no longer read: listed, unchanged until confirmed.
    const breaks = (yield* entriesOf(before.scopeId)).filter(
      (entry) =>
        entry.providerId !== input.providerId || !prefixAllows(input.allowedPaths, entry.reference),
    );
    if (breaks.length > 0 && input.confirm !== true) {
      return { scope: null, breaks: breaks.map(breakOf) };
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE secret_provider_scopes SET provider_id = ${input.providerId}, label = ${input.label},
              auth_json = ${values.auth}, allowed_paths_json = ${values.paths},
              writable = ${values.writable}, probe_reference = ${values.probe}, updated_at = ${at}
            WHERE scope_id = ${before.scopeId}
          `;
          yield* record(
            userId,
            "provider_scope.update",
            { kind: "provider_scope", id: before.scopeId, name: input.label },
            {
              provider: input.providerId,
              paths: input.allowedPaths.length,
              writable: values.writable === 1,
              broke: breaks.length,
            },
          );
        }),
      )
      .pipe(Effect.catch(storage("change the scope")));
    return { scope: yield* viewOf(yield* findScope(before.scopeId)), breaks: breaks.map(breakOf) };
  });

  const remove = Effect.fn("SecretProviderScopes.remove")(function* (
    input: ProviderScopeDeleteInput,
  ) {
    const userId = yield* owner;
    const scope = yield* findScope(input.scopeId);
    const breaks = (yield* entriesOf(scope.scopeId)).map(breakOf);
    if (breaks.length > 0 && input.confirm !== true) return { deleted: false, breaks };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM vault_provider_scopes WHERE scope_id = ${scope.scopeId}`;
          yield* sql`DELETE FROM secret_provider_scopes WHERE scope_id = ${scope.scopeId}`;
          yield* record(
            userId,
            "provider_scope.delete",
            { kind: "provider_scope", id: scope.scopeId, name: scope.label },
            { provider: scope.providerId, broke: breaks.length },
          );
        }),
      )
      .pipe(Effect.catch(storage("delete the scope")));
    return { deleted: true, breaks };
  });

  const allow = Effect.fn("SecretProviderScopes.allow")(function* (input: ProviderScopeAllowInput) {
    const userId = yield* owner;
    const scope = yield* findScope(input.scopeId);
    const vaults = yield* sql<{ readonly name: string; readonly spaceId: string | null }>`
      SELECT name, space_id AS "spaceId" FROM vaults WHERE vault_id = ${input.vaultId}
    `.pipe(Effect.catch(storage("read the Vault")));
    const vault = vaults[0];
    if (vault === undefined) return yield* fail("not-found", "That Vault does not exist.");
    if (input.vaultId === MAIN_VAULT_ID) {
      return yield* fail("invalid", "The Main vault is yours alone: add «Direct» entries to it.");
    }
    const at = yield* now;
    const breaks = input.allowed
      ? []
      : (yield* entriesOf(scope.scopeId, input.vaultId)).map(breakOf);
    if (breaks.length > 0 && input.confirm !== true) return { scope: null, breaks };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.allowed) {
            yield* sql`
              INSERT INTO vault_provider_scopes (vault_id, scope_id, created_at)
              VALUES (${input.vaultId}, ${scope.scopeId}, ${at})
              ON CONFLICT (vault_id, scope_id) DO NOTHING
            `;
          } else {
            yield* sql`
              DELETE FROM vault_provider_scopes
              WHERE vault_id = ${input.vaultId} AND scope_id = ${scope.scopeId}
            `;
          }
          yield* record(
            userId,
            "provider_scope.allow",
            { kind: "provider_scope", id: scope.scopeId, name: scope.label },
            {
              vault: vault.name,
              vaultId: input.vaultId,
              allowed: input.allowed,
              broke: breaks.length,
            },
            vault.spaceId as SpaceId | null,
          );
        }),
      )
      .pipe(Effect.catch(storage("change the scope's Vaults")));
    return { scope: yield* viewOf(yield* findScope(scope.scopeId)), breaks };
  });

  const test = Effect.fn("SecretProviderScopes.test")(function* (input: SecretProviderTestInput) {
    const userId = yield* owner;
    let probe: string | undefined;
    let scopeLabel: string | null = null;
    let auth: Readonly<Record<string, string>> = {};
    if (input.scopeId !== undefined) {
      const scope = yield* findScope(input.scopeId);
      if (scope.providerId !== input.providerId) {
        return yield* fail("invalid", "That scope reads another provider.");
      }
      scopeLabel = scope.label;
      // Signed in as the scope's reads are: its role, mount, and namespace.
      auth = authOf(scope.auth);
      // The probe is read only inside the scope's own paths (it may have been narrowed since).
      if (scope.probeReference !== null) {
        if (
          !prefixAllows(pathsOf(scope.paths), scope.probeReference) ||
          ProviderReads.referencePathProblem(scope.probeReference) !== undefined
        ) {
          return yield* fail("invalid", "The probe path must be inside the scope's allowed paths.");
        }
        probe = scope.probeReference;
      }
    }
    const result = yield* reads.test(input.providerId, probe, auth);
    yield* record(
      userId,
      "secret_provider.test",
      { kind: "secret_provider", id: input.providerId, name: input.providerId },
      {
        scope: scopeLabel,
        auth: result.auth.ok ? "ok" : (result.auth.error ?? "failed"),
        probe:
          result.probe === undefined
            ? null
            : result.probe.ok
              ? "ok"
              : (result.probe.error ?? "failed"),
      },
    );
    return result;
  });

  const impact = Effect.fn("SecretProviderScopes.impact")(function* (
    input: SecretProviderImpactInput,
  ) {
    yield* owner;
    const scopes = yield* sql<{ readonly scopeId: string; readonly label: string }>`
      SELECT scope_id AS "scopeId", label FROM secret_provider_scopes
      WHERE provider_id = ${input.providerId} ORDER BY label
    `.pipe(Effect.catch(storage("read the scopes")));
    const entries = yield* sql<EntryRow>`
      SELECT e.vault_id AS "vaultId", v.name AS "vaultName", e.entry_id AS "entryId", e.name AS "name",
        e.provider_reference AS "reference", e.provider_id AS "providerId"
      FROM vault_entries e JOIN vaults v ON v.vault_id = e.vault_id
      WHERE e.kind = 'provider' AND e.provider_id = ${input.providerId}
      ORDER BY v.name, e.name
    `.pipe(Effect.catch(storage("read the provider's entries")));
    return {
      scopes: scopes.map((scope) => ({
        id: ProviderScopeId.make(scope.scopeId),
        label: scope.label,
      })),
      breaks: entries.map(breakOf),
    };
  });

  const recordProviderChanges: SecretProviderScopes["Service"]["recordProviderChanges"] = Effect.fn(
    "SecretProviderScopes.recordProviderChanges",
  )(
    function* (before, after) {
      const acting = yield* spaces.actingUser.pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(acting)) return;
      const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const id of ids) {
        const was = before[id as SecretProviderId];
        const is = after[id as SecretProviderId];
        if (was === undefined && is === undefined) continue;
        const target = {
          kind: "secret_provider" as const,
          id,
          name: is?.label ?? was?.label ?? id,
        };
        if (is === undefined) {
          yield* record(acting.value, "secret_provider.delete", target, { kind: was!.kind });
          continue;
        }
        // Field names only: a credential's value never reaches the log, changed or not.
        const wasConfig = (was?.config ?? {}) as Record<string, unknown>;
        const isConfig = (is.config ?? {}) as Record<string, unknown>;
        const changed = [
          ...(was?.label !== is.label ? ["label"] : []),
          ...[...new Set([...Object.keys(wasConfig), ...Object.keys(isConfig)])].filter(
            (field) => !sameValue(wasConfig[field], isConfig[field]),
          ),
        ];
        if (was !== undefined && changed.length === 0) continue;
        yield* record(
          acting.value,
          was === undefined ? "secret_provider.create" : "secret_provider.update",
          target,
          { kind: is.kind, changed: changed.join(", ") },
        );
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("SecretProviderScopes: could not record a provider change", { cause }),
    ),
  );

  return SecretProviderScopes.of({ list, put, remove, allow, test, impact, recordProviderChanges });
});

export const layer = Layer.effect(SecretProviderScopes, make);

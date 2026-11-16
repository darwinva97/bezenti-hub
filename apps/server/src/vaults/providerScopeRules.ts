/**
 * The rule a Provider scope sets (Vaults ticket 03), the same when an entry is saved and before
 * every read: the scope exists, reads the entry's provider, is allowed to the entry's Vault, and
 * the reference falls under one of its path prefixes at a segment boundary, case and all.
 */
import { PROVIDER_SCOPE_AUTH_FIELDS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

const SEGMENT_ENDS = ["/", "#", "?"] as const;
const AUTH_FIELDS: ReadonlySet<string> = new Set(PROVIDER_SCOPE_AUTH_FIELDS);

/**
 * Whether `reference` is a prefix itself or lies under one: `kv/acme` admits `kv/acme`,
 * `kv/acme/app` and `kv/acme#token`, never `kv/acme-evil` nor `KV/acme`. A prefix that already
 * ends at a boundary (`kv/acme/`, `op://`) admits what follows it.
 */
export const prefixAllows = (prefixes: ReadonlyArray<string>, reference: string): boolean =>
  prefixes.some(
    (prefix) =>
      prefix.length > 0 &&
      (reference === prefix ||
        (SEGMENT_ENDS.some((end) => prefix.endsWith(end))
          ? reference.startsWith(prefix)
          : SEGMENT_ENDS.some((end) => reference.startsWith(`${prefix}${end}`)))),
  );

/** The paths a scope row allows; a row that does not parse allows nothing. */
export const pathsOf = (json: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((path) => typeof path === "string") : [];
  } catch {
    return [];
  }
};

/**
 * A scope row's `auth`: the non-secret sign-in fields (role, mount, namespace...) it lays over
 * its provider's config. A row that does not parse sets nothing; only allowed string fields count.
 */
export const authOf = (json: string): Readonly<Record<string, string>> => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && AUTH_FIELDS.has(entry[0]),
      ),
    );
  } catch {
    return {};
  }
};

/** The `auth` a scope lays over its provider's config; none for a scope that is gone. */
export const scopeAuthOf = Effect.fn("ProviderScopeRules.scopeAuthOf")(function* (
  sql: SqlClient.SqlClient,
  scopeId: string,
) {
  const rows = yield* sql<{ readonly auth: string }>`
    SELECT auth_json AS "auth" FROM secret_provider_scopes WHERE scope_id = ${scopeId}
  `;
  return rows[0] === undefined ? {} : authOf(rows[0].auth);
});

/** Whether the scope still allows the reference in its Vault (scope set; read, never cached). */
export const scopeAllows = Effect.fn("ProviderScopeRules.scopeAllows")(function* (
  sql: SqlClient.SqlClient,
  ref: {
    readonly providerId: string;
    readonly scopeId: string | null;
    readonly reference: string;
    readonly vaultId?: string | null;
  },
) {
  if (ref.scopeId === null || ref.vaultId === undefined || ref.vaultId === null) return false;
  const rows = yield* sql<{ readonly providerId: string; readonly paths: string }>`
    SELECT s.provider_id AS "providerId", s.allowed_paths_json AS "paths"
    FROM secret_provider_scopes s
    JOIN vault_provider_scopes a ON a.scope_id = s.scope_id AND a.vault_id = ${ref.vaultId}
    WHERE s.scope_id = ${ref.scopeId}
  `;
  const row = rows[0];
  return (
    row !== undefined &&
    row.providerId === ref.providerId &&
    prefixAllows(pathsOf(row.paths), ref.reference)
  );
});

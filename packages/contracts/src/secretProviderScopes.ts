/**
 * Provider scopes (Vaults ticket 03): what a Secret provider lets the Hub read for a Vault (its
 * role and the path prefixes allowed), and which Vaults may use it. Never a value or a credential.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, makeEntityId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SecretProviderId } from "./secretReference.ts";
import { VaultEntryId, VaultId } from "./vaults.ts";

export const ProviderScopeId = makeEntityId("ProviderScopeId");
export type ProviderScopeId = typeof ProviderScopeId.Type;

/**
 * The non-secret settings a scope overrides on its provider. Anything else is refused: a credential
 * never goes here (it is sealed in the store), and an unknown key is a mistake, not a pass-through.
 */
export const PROVIDER_SCOPE_AUTH_FIELDS = [
  "role",
  "mount",
  "method",
  "namespace",
  "audience",
  "project",
  "environment",
] as const;
const AUTH_FIELDS: ReadonlySet<string> = new Set(PROVIDER_SCOPE_AUTH_FIELDS);
export const ProviderScopeAuth = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isMaxLength(256)),
).check(
  Schema.makeFilter((auth: Readonly<Record<string, string>>) => {
    const unknown = Object.keys(auth).filter((key) => !AUTH_FIELDS.has(key));
    return unknown.length === 0
      ? true
      : `A scope sets only ${PROVIDER_SCOPE_AUTH_FIELDS.join(", ")}; not ${unknown.join(", ")}.`;
  }),
);
export type ProviderScopeAuth = typeof ProviderScopeAuth.Type;

const ScopePath = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

/** A Provider entry that a change would break (shown, never delivered, after it). */
export const ProviderEntryBreak = Schema.Struct({
  vaultId: VaultId,
  vaultName: Schema.String,
  entryId: VaultEntryId,
  name: Schema.String,
});
export type ProviderEntryBreak = typeof ProviderEntryBreak.Type;

export const ProviderScope = Schema.Struct({
  id: ProviderScopeId,
  providerId: SecretProviderId,
  /** The provider's label; null once it is gone from the settings (the scope is then broken). */
  providerLabel: Schema.NullOr(Schema.String),
  label: Schema.String,
  auth: ProviderScopeAuth,
  allowedPaths: Schema.Array(Schema.String),
  writable: Schema.Boolean,
  /** «Test connection» reads it; inside `allowedPaths`. Never its value. */
  probeReference: Schema.NullOr(Schema.String),
  vaults: Schema.Array(Schema.Struct({ vaultId: VaultId, name: Schema.String })),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderScope = typeof ProviderScope.Type;

export const ProviderScopesListInput = Schema.Struct({});
export const ProviderScopesListResult = Schema.Struct({ scopes: Schema.Array(ProviderScope) });
export type ProviderScopesListResult = typeof ProviderScopesListResult.Type;

/**
 * Adds a scope (no `scopeId`) or changes one. A change that would break Provider entries (fewer
 * paths, another provider) is refused and lists them unless `confirm`.
 */
export const ProviderScopePutInput = Schema.Struct({
  scopeId: Schema.optionalKey(ProviderScopeId),
  providerId: SecretProviderId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  auth: ProviderScopeAuth,
  allowedPaths: Schema.Array(ScopePath).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  writable: Schema.optionalKey(Schema.Boolean),
  probeReference: Schema.optionalKey(Schema.NullOr(ScopePath)),
  confirm: Schema.optionalKey(Schema.Boolean),
});
export type ProviderScopePutInput = typeof ProviderScopePutInput.Type;

/** A change that would break entries: not saved (`scope` null) until confirmed. */
export const ProviderScopeChangeResult = Schema.Struct({
  scope: Schema.NullOr(ProviderScope),
  breaks: Schema.Array(ProviderEntryBreak),
});
export type ProviderScopeChangeResult = typeof ProviderScopeChangeResult.Type;

export const ProviderScopeDeleteInput = Schema.Struct({
  scopeId: ProviderScopeId,
  confirm: Schema.optionalKey(Schema.Boolean),
});
export type ProviderScopeDeleteInput = typeof ProviderScopeDeleteInput.Type;
export const ProviderScopeDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
  breaks: Schema.Array(ProviderEntryBreak),
});
export type ProviderScopeDeleteResult = typeof ProviderScopeDeleteResult.Type;

/** Allows a scope to a Vault, or takes it back (which breaks its entries there: confirm). */
export const ProviderScopeAllowInput = Schema.Struct({
  scopeId: ProviderScopeId,
  vaultId: VaultId,
  allowed: Schema.Boolean,
  confirm: Schema.optionalKey(Schema.Boolean),
});
export type ProviderScopeAllowInput = typeof ProviderScopeAllowInput.Type;

/** A class of outcome, never what the provider said. */
export const SecretProviderCheck = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.Literals(["not-found", "forbidden", "unavailable", "invalid"])),
});
export type SecretProviderCheck = typeof SecretProviderCheck.Type;

/** «Test connection»: the provider's sign-in, and a scope's probe read. */
export const SecretProviderTestInput = Schema.Struct({
  providerId: SecretProviderId,
  scopeId: Schema.optionalKey(ProviderScopeId),
});
export type SecretProviderTestInput = typeof SecretProviderTestInput.Type;
export const SecretProviderTestResult = Schema.Struct({
  auth: SecretProviderCheck,
  probe: Schema.optionalKey(SecretProviderCheck),
});
export type SecretProviderTestResult = typeof SecretProviderTestResult.Type;

/** What deleting a provider would break: its scopes and the entries reading through it. */
export const SecretProviderImpactInput = Schema.Struct({ providerId: SecretProviderId });
export type SecretProviderImpactInput = typeof SecretProviderImpactInput.Type;
export const SecretProviderImpact = Schema.Struct({
  scopes: Schema.Array(Schema.Struct({ id: ProviderScopeId, label: Schema.String })),
  breaks: Schema.Array(ProviderEntryBreak),
});
export type SecretProviderImpact = typeof SecretProviderImpact.Type;

/** For a Vault's editors: the scopes they may add Provider entries through. */
export const VaultProviderScopesInput = Schema.Struct({ vaultId: VaultId });
export type VaultProviderScopesInput = typeof VaultProviderScopesInput.Type;
export const VaultProviderScopes = Schema.Struct({
  scopes: Schema.Array(
    Schema.Struct({
      id: ProviderScopeId,
      label: Schema.String,
      providerId: SecretProviderId,
      providerLabel: Schema.String,
      allowedPaths: Schema.Array(Schema.String),
      referencePlaceholder: Schema.String,
    }),
  ),
  /** The Owner may also read a provider directly («Direct»), without a scope. */
  direct: Schema.Array(
    Schema.Struct({
      providerId: SecretProviderId,
      providerLabel: Schema.String,
      referencePlaceholder: Schema.String,
    }),
  ),
});
export type VaultProviderScopes = typeof VaultProviderScopes.Type;

export const SecretProviderScopeErrorReason = Schema.Literals([
  "not-found",
  "forbidden",
  "invalid",
  "duplicate-label",
  "storage",
]);
/** Names scopes and providers, never a value or a credential. */
export class SecretProviderScopeError extends Schema.TaggedError<SecretProviderScopeError>()(
  "SecretProviderScopeError",
  { reason: SecretProviderScopeErrorReason, message: Schema.String },
) {}

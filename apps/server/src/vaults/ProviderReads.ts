/**
 * The one place that asks a Secret provider for a Vault entry's value (ADR 0008). References are
 * checked again before every read; only a class of failure leaves, never what a provider said.
 * docs/internals/secrets.md, «Provider entries» and «Provider scopes».
 */
import {
  isSecretReference,
  type SecretProviderCheck,
  type SecretProviderId,
  type SecretReference,
  type ServerSettings,
} from "@t3tools/contracts";
import type {
  SecretProviderDriver,
  SecretProviderDriverServices,
  SecretReadError,
  SecretReadResult,
} from "@t3tools/secret-provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "../secrets/secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";
import { scopeAllows } from "./providerScopeRules.ts";

/** What one read waits for a provider, at most; past it the group is `unavailable`. */
const PROVIDER_READ_TIMEOUT = Duration.seconds(10);
/** How long a value without its own expiry is held. */
const DEFAULT_REFRESH_INTERVAL = Duration.minutes(5);

/**
 * Where one Provider entry reads its value: through a Provider scope allowed to its Vault, or
 * (scope null) the Owner's own «Direct» access.
 */
export interface ProviderRef {
  readonly providerId: string;
  readonly scopeId: string | null;
  readonly reference: string;
  /** The entry's Vault: a scope must still be allowed to it. Null: no scope rule applies. */
  readonly vaultId?: string | null;
}

/** One reference's outcome: a value, a classified failure, or an entry that is broken. */
export type ProviderOutcome =
  | { readonly _tag: "value"; readonly value: string }
  | { readonly _tag: "error"; readonly error: SecretReadError; readonly label: string }
  | { readonly _tag: "broken" };

/** What Settings → Vaults says of a provider, without reading it. */
export interface ProviderStatus {
  /** The provider's label; null once it is gone from the settings. */
  readonly label: string | null;
  /** Gone, or of a kind this Hub has no driver for: shown, never delivered. */
  readonly broken: boolean;
}

/** A provider this Hub can read, for the pickers. */
export interface ReadableProvider {
  readonly providerId: string;
  readonly label: string;
  readonly referencePlaceholder: string;
}

export class ProviderReads extends Context.Service<
  ProviderReads,
  {
    readonly status: (providerId: string) => Effect.Effect<ProviderStatus>;
    readonly providers: Effect.Effect<ReadonlyArray<ReadableProvider>>;
    /** At save: why the reference cannot be read by this provider, or undefined. Never a read. */
    readonly referenceProblem: (ref: ProviderRef) => Effect.Effect<string | undefined>;
    /** Whether the entry's scope, if any, still allows it (no read): else it is broken. */
    readonly allowed: (ref: ProviderRef) => Effect.Effect<boolean>;
    /** Outcomes in input order; never fails (a failure is an outcome). */
    readonly read: (
      refs: ReadonlyArray<ProviderRef>,
    ) => Effect.Effect<ReadonlyArray<ProviderOutcome>>;
    /**
     * «Test connection»: the provider's sign-in and, given one, a probe read (direct, never
     * cached). Classes only: never a value nor what the provider said.
     */
    readonly test: (
      providerId: string,
      probe?: string,
    ) => Effect.Effect<{
      readonly auth: SecretProviderCheck;
      readonly probe?: SecretProviderCheck;
    }>;
  }
>()("t3/vaults/ProviderReads") {}

// Path tricks a reference must never carry, raw or decoded: a parent segment, an empty one, an
// encoded dot or slash, a backslash, or a control character.
const ENCODED_PATH = /%2e|%2f|%5c/iu;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * Why a reference is not a plain path inside its provider, or undefined. Checked when saved and
 * before every read (a row written by other means is refused too).
 */
export const referencePathProblem = (reference: string): string | undefined => {
  if (reference.trim() !== reference || reference.length === 0) {
    return "A reference has no surrounding spaces.";
  }
  if (CONTROL.test(reference) || reference.includes("\\")) {
    return "A reference has no control characters or backslashes.";
  }
  if (ENCODED_PATH.test(reference)) return "A reference has no encoded dots or slashes.";
  // The path: what follows a scheme (`op://`), up to a field or query (`#`, `?`).
  const path = reference.replace(SCHEME, "").split(/[#?]/u)[0] ?? "";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "A reference stays inside its provider: no `.` or `..`.";
  }
  if (segments.slice(1).some((segment) => segment.length === 0) || path.startsWith("/")) {
    return "A reference has no empty path segment (`//`).";
  }
  return undefined;
};

interface Cached {
  readonly configKey: string;
  readonly value: string;
  readonly expiresAt: number;
}

const keyOf = (ref: ProviderRef) =>
  `${ref.providerId}\u0000${ref.scopeId ?? ""}\u0000${ref.reference}`;

const refreshIntervalOf = (config: unknown): Duration.Duration => {
  const seconds =
    typeof config === "object" && config !== null && "refreshIntervalSeconds" in config
      ? (config as { readonly refreshIntervalSeconds: unknown }).refreshIntervalSeconds
      : undefined;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Duration.seconds(seconds)
    : DEFAULT_REFRESH_INTERVAL;
};

interface Plan {
  readonly driver: SecretProviderDriver;
  readonly config: unknown;
  readonly configKey: string;
  readonly label: string;
  readonly refresh: Duration.Duration;
}

const UNAVAILABLE: SecretReadResult = { _tag: "error", error: "unavailable" };

export const make = Effect.fn("ProviderReads.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
  readonly secretProviders: Effect.Effect<ServerSettings["secretProviders"]>;
  /** Each change of the settings: the providers whose config changed or went are forgotten. */
  readonly changes?: Stream.Stream<ServerSettings["secretProviders"]>;
  /** Whether a scope still allows the reference in its Vault; without it, no scope does. */
  readonly scopeAllows?: (ref: ProviderRef) => Effect.Effect<boolean>;
  /** A provider credential read from another provider; unreadable: undefined. */
  readonly readCredential?: (reference: SecretReference) => Effect.Effect<string | undefined>;
}) {
  const context = yield* Effect.context<SecretProviderDriverServices>();
  const drivers = new Map(
    options.drivers.map((driver) => [
      driver.kind as string,
      {
        driver,
        decodeConfig: Schema.decodeUnknownOption(
          driver.definition.configSchema as Schema.Codec<unknown, unknown>,
        ),
      },
    ]),
  );
  const cache = new Map<string, Cached>();
  const inFlight = new Map<string, Deferred.Deferred<SecretReadResult>>();

  /** The settings with each credential a provider reads from another provider filled in. */
  const providersNow = Effect.gen(function* () {
    const providers = yield* options.secretProviders;
    const filled: Record<string, ServerSettings["secretProviders"][SecretProviderId]> = {};
    for (const [id, entry] of Object.entries(providers)) {
      const fields = drivers.get(entry.kind)?.driver.definition.credentialFields ?? [];
      const config = entry.config as Record<string, unknown> | undefined;
      if (fields.length === 0 || config === undefined || typeof config !== "object") {
        filled[id] = entry;
        continue;
      }
      const next = { ...config };
      for (const field of fields) {
        const value = next[field];
        if (!isSecretReference(value)) continue;
        next[field] =
          options.readCredential === undefined
            ? ""
            : ((yield* options.readCredential(value)) ?? "");
      }
      filled[id] = { ...entry, config: next };
    }
    return filled as ServerSettings["secretProviders"];
  });

  const planOf = (
    providers: ServerSettings["secretProviders"],
    providerId: string,
  ): Plan | undefined => {
    const provider = providers[providerId as SecretProviderId];
    const known = provider === undefined ? undefined : drivers.get(provider.kind);
    if (provider === undefined || known === undefined) return undefined;
    const decoded = known.decodeConfig(provider.config);
    if (Option.isNone(decoded)) return undefined;
    return {
      driver: known.driver,
      config: decoded.value,
      configKey: JSON.stringify([provider.kind, decoded.value]),
      label: provider.label,
      refresh: refreshIntervalOf(provider.config),
    };
  };

  /** A changed or removed provider's values go at once, not when they would expire. */
  const forgetChanged = (providers: ServerSettings["secretProviders"]) =>
    Effect.sync(() => {
      const ids = new Set(Object.keys(providers));
      for (const [key, cached] of cache) {
        const providerId = key.slice(0, key.indexOf("\u0000"));
        // A credential read elsewhere is not known here: its provider's entries go too.
        if (!ids.has(providerId) || planOf(providers, providerId)?.configKey !== cached.configKey) {
          cache.delete(key);
        }
      }
    });
  if (options.changes !== undefined) {
    yield* options.changes.pipe(Stream.runForEach(forgetChanged), Effect.forkScoped);
  }

  const allowed: ProviderReads["Service"]["allowed"] = (ref) =>
    ref.scopeId === null
      ? Effect.succeed(true)
      : options.scopeAllows === undefined
        ? Effect.succeed(false)
        : options.scopeAllows(ref);

  const status: ProviderReads["Service"]["status"] = (providerId) =>
    options.secretProviders.pipe(
      Effect.map((providers) => ({
        label: providers[providerId as SecretProviderId]?.label ?? null,
        broken:
          providers[providerId as SecretProviderId] === undefined ||
          !drivers.has(providers[providerId as SecretProviderId]!.kind),
      })),
    );

  const providers: ProviderReads["Service"]["providers"] = options.secretProviders.pipe(
    Effect.map((current) =>
      Object.entries(current).flatMap(([providerId, entry]) => {
        const known = drivers.get(entry.kind);
        return known === undefined
          ? []
          : [
              {
                providerId,
                label: entry.label,
                referencePlaceholder: known.driver.definition.referencePlaceholder,
              },
            ];
      }),
    ),
  );

  const referenceProblem: ProviderReads["Service"]["referenceProblem"] = Effect.fn(
    "ProviderReads.referenceProblem",
  )(function* (ref) {
    const current = yield* options.secretProviders;
    const provider = current[ref.providerId as SecretProviderId];
    const definition =
      provider === undefined ? undefined : drivers.get(provider.kind)?.driver.definition;
    if (definition === undefined) {
      return "That provider is not connected, or this Hub cannot read it.";
    }
    const pathProblem = referencePathProblem(ref.reference);
    if (pathProblem !== undefined) return pathProblem;
    if (!definition.isReference(ref.reference)) return definition.invalidReferenceMessage;
    if (!(yield* allowed(ref))) return "That path is outside the scope allowed to this Vault.";
    return undefined;
  });

  /** Releases the reads waiting on `refs` still in flight (an interrupted batch): unavailable. */
  const releaseUnanswered = (refs: ReadonlyArray<ProviderRef>) =>
    Effect.forEach(
      refs,
      (ref) => {
        const key = keyOf(ref);
        const waiting = inFlight.get(key);
        inFlight.delete(key);
        return waiting === undefined ? Effect.void : Deferred.succeed(waiting, UNAVAILABLE);
      },
      { discard: true },
    );

  /** A driver call bounded by the timeout; a death is unavailable and its cause never logged. */
  const bounded = <A>(plan: Plan, call: Effect.Effect<A, never, SecretProviderDriverServices>) =>
    call.pipe(
      Effect.provideContext(context),
      Effect.timeoutOption(PROVIDER_READ_TIMEOUT),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        () =>
          Effect.logWarning("ProviderReads: a provider's call failed", {
            provider: plan.label,
          }).pipe(Effect.as(Option.none<A>())),
      ),
    );

  /** One provider's batch: bounded, every reference answered, the waiting reads released. */
  const readGroup = (plan: Plan, refs: ReadonlyArray<ProviderRef>) =>
    bounded(
      plan,
      plan.driver.read(
        plan.config,
        refs.map((ref) => ref.reference),
      ),
    ).pipe(
      Effect.map(
        Option.match({
          onNone: () => refs.map(() => UNAVAILABLE),
          onSome: (results) => refs.map((_, index) => results[index] ?? UNAVAILABLE),
        }),
      ),
      Effect.tap((results) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.forEach(
            refs,
            (ref, index) => {
              const result = results[index]!;
              const key = keyOf(ref);
              if (result._tag === "value") {
                cache.set(key, {
                  configKey: plan.configKey,
                  value: result.value,
                  expiresAt: Math.min(
                    result.expiresAt ?? Number.POSITIVE_INFINITY,
                    now + Duration.toMillis(plan.refresh),
                  ),
                });
              }
              const waiting = inFlight.get(key);
              inFlight.delete(key);
              return waiting === undefined ? Effect.void : Deferred.succeed(waiting, result);
            },
            { discard: true },
          );
        }),
      ),
      Effect.ensuring(releaseUnanswered(refs)),
    );

  const read: ProviderReads["Service"]["read"] = Effect.fn("ProviderReads.read")(function* (refs) {
    const current = yield* providersNow;
    const now = yield* Clock.currentTimeMillis;
    const outcomes: Array<
      | { readonly _tag: "known"; readonly outcome: ProviderOutcome }
      | { readonly _tag: "waiting"; readonly result: Deferred.Deferred<SecretReadResult> }
    > = [];
    const known = (outcome: ProviderOutcome) => outcomes.push({ _tag: "known", outcome });
    const plans = new Map<string, Plan>();
    // Misses this call reads, by provider and scope; a reference already being read is awaited.
    const groups = new Map<string, { readonly plan: Plan; readonly refs: Array<ProviderRef> }>();
    for (const ref of refs) {
      const plan = planOf(current, ref.providerId);
      // Provider gone, or a scope that no longer allows it here: broken, never read.
      if (plan === undefined || !(yield* allowed(ref))) {
        known({ _tag: "broken" });
        continue;
      }
      plans.set(ref.providerId, plan);
      if (
        referencePathProblem(ref.reference) !== undefined ||
        !plan.driver.definition.isReference(ref.reference)
      ) {
        known({ _tag: "error", error: "invalid", label: plan.label });
        continue;
      }
      const key = keyOf(ref);
      const cached = cache.get(key);
      if (cached !== undefined && cached.configKey === plan.configKey && now < cached.expiresAt) {
        known({ _tag: "value", value: cached.value });
        continue;
      }
      const running = inFlight.get(key);
      if (running !== undefined) {
        outcomes.push({ _tag: "waiting", result: running });
        continue;
      }
      const waiting = yield* Deferred.make<SecretReadResult>();
      inFlight.set(key, waiting);
      outcomes.push({ _tag: "waiting", result: waiting });
      const groupKey = `${ref.providerId}\u0000${ref.scopeId ?? ""}`;
      const group = groups.get(groupKey) ?? { plan, refs: [] };
      if (!group.refs.some((other) => other.reference === ref.reference)) group.refs.push(ref);
      groups.set(groupKey, group);
    }
    // Every provider at once; each in one batch. An interrupted batch releases its waiters.
    yield* Effect.forEach([...groups.values()], ({ plan, refs: batch }) => readGroup(plan, batch), {
      concurrency: "unbounded",
      discard: true,
    });
    return yield* Effect.forEach(outcomes, (outcome, index) =>
      outcome._tag === "known"
        ? Effect.succeed(outcome.outcome)
        : Deferred.await(outcome.result).pipe(
            Effect.map((result): ProviderOutcome => {
              if (result._tag === "value") return { _tag: "value", value: result.value };
              const label = plans.get(refs[index]!.providerId)?.label ?? refs[index]!.providerId;
              return { _tag: "error", error: result.error, label };
            }),
          ),
    );
  });

  const test: ProviderReads["Service"]["test"] = Effect.fn("ProviderReads.test")(
    function* (providerId, probe) {
      const plan = planOf(yield* providersNow, providerId);
      if (plan === undefined) {
        return {
          auth: { ok: false, error: "invalid" as const },
          ...(probe === undefined ? {} : { probe: { ok: false, error: "invalid" as const } }),
        };
      }
      const signedIn = yield* bounded(plan, plan.driver.test(plan.config));
      const auth: SecretProviderCheck = Option.match(signedIn, {
        onNone: () => ({ ok: false, error: "unavailable" }),
        onSome: (report) =>
          report.ok
            ? { ok: true }
            : { ok: false, ...(report.error ? { error: report.error } : {}) },
      });
      if (probe === undefined) return { auth };
      const read = yield* bounded(plan, plan.driver.read(plan.config, [probe]));
      const result = Option.isSome(read) ? (read.value[0] ?? UNAVAILABLE) : UNAVAILABLE;
      return {
        auth,
        probe: result._tag === "value" ? { ok: true } : { ok: false, error: result.error },
      };
    },
  );

  return ProviderReads.of({ status, providers, referenceProblem, allowed, read, test });
});

/**
 * The Hub's: the built-in drivers, the Owner's settings (forgetting what a change replaced), the
 * scopes' rules in the database, and credentials read from other providers by the settings' own
 * resolver.
 */
export const layer = Layer.effect(
  ProviderReads,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    const resolver = yield* Effect.serviceOption(SecretResolver.SecretResolver);
    const providers = settings.getSettings.pipe(
      Effect.map((current) => current.secretProviders),
      Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
    );
    return yield* make({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
      secretProviders: providers,
      changes: settings.streamChanges.pipe(Stream.map((current) => current.secretProviders)),
      scopeAllows: (ref) => scopeAllows(sql, ref).pipe(Effect.orElseSucceed(() => false)),
      ...(Option.isNone(resolver)
        ? {}
        : {
            readCredential: (reference: SecretReference) =>
              resolver.value.read([reference]).pipe(Effect.map((values) => values[0])),
          }),
    });
  }),
);

/**
 * The one place that asks a Secret provider for a Vault entry's value (ADR 0008). References are
 * checked again before every read; only a class of failure leaves, never what a provider said.
 * docs/internals/secrets.md, «Provider entries».
 */
import type { SecretProviderId, ServerSettings } from "@t3tools/contracts";
import type {
  SecretProviderDriver,
  SecretProviderDriverServices,
  SecretReadError,
  SecretReadResult,
} from "@t3tools/secret-provider-core/server/driver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "../secrets/secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

/** What one read waits for a provider, at most; past it the group is `unavailable`. */
const PROVIDER_READ_TIMEOUT = Duration.seconds(10);
/** How long a value without its own expiry is held. */
const DEFAULT_REFRESH_INTERVAL = Duration.minutes(5);

/** Where one Provider entry reads its value. The scope is ticket 03's: null is the Owner's own. */
export interface ProviderRef {
  readonly providerId: string;
  readonly scopeId: string | null;
  readonly reference: string;
}

/** One reference's outcome: a value, a classified failure, or a provider that is gone. */
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

export class ProviderReads extends Context.Service<
  ProviderReads,
  {
    readonly status: (providerId: string) => Effect.Effect<ProviderStatus>;
    /** At save: why the reference cannot be read by this provider, or undefined. Never a read. */
    readonly referenceProblem: (ref: ProviderRef) => Effect.Effect<string | undefined>;
    /** Outcomes in input order; never fails (a failure is an outcome). */
    readonly read: (
      refs: ReadonlyArray<ProviderRef>,
    ) => Effect.Effect<ReadonlyArray<ProviderOutcome>>;
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

/** Ticket 03 gives scopes their allowed paths; without a scope a reference is the Owner's own. */
const allowedBy = (_scopeId: string | null, _reference: string): boolean => true;

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

export const make = Effect.fn("ProviderReads.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
  readonly secretProviders: Effect.Effect<ServerSettings["secretProviders"]>;
  /** Each change of the settings: the providers whose config changed or went are forgotten. */
  readonly changes?: Stream.Stream<ServerSettings["secretProviders"]>;
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
      for (const [key, cached] of cache) {
        const providerId = key.slice(0, key.indexOf("\u0000"));
        if (planOf(providers, providerId)?.configKey !== cached.configKey) cache.delete(key);
      }
    });
  if (options.changes !== undefined) {
    yield* options.changes.pipe(Stream.runForEach(forgetChanged), Effect.forkScoped);
  }

  const status: ProviderReads["Service"]["status"] = (providerId) =>
    options.secretProviders.pipe(
      Effect.map((providers) => ({
        label: providers[providerId as SecretProviderId]?.label ?? null,
        broken: planOf(providers, providerId) === undefined,
      })),
    );

  const referenceProblem: ProviderReads["Service"]["referenceProblem"] = (ref) =>
    options.secretProviders.pipe(
      Effect.map((providers) => {
        const plan = planOf(providers, ref.providerId);
        if (plan === undefined)
          return "That provider is not connected, or this Hub cannot read it.";
        const pathProblem = referencePathProblem(ref.reference);
        if (pathProblem !== undefined) return pathProblem;
        if (!plan.driver.definition.isReference(ref.reference)) {
          return plan.driver.definition.invalidReferenceMessage;
        }
        if (!allowedBy(ref.scopeId, ref.reference)) return "That path is outside the scope.";
        return undefined;
      }),
    );

  /** Releases the reads waiting on `refs` still in flight (an interrupted batch): unavailable. */
  const releaseUnanswered = (refs: ReadonlyArray<ProviderRef>) =>
    Effect.forEach(
      refs,
      (ref) => {
        const key = keyOf(ref);
        const waiting = inFlight.get(key);
        inFlight.delete(key);
        return waiting === undefined
          ? Effect.void
          : Deferred.succeed(waiting, { _tag: "error", error: "unavailable" });
      },
      { discard: true },
    );

  /** One provider's batch: bounded, every reference answered, the waiting reads released. */
  const readGroup = (plan: Plan, refs: ReadonlyArray<ProviderRef>) =>
    plan.driver
      .read(
        plan.config,
        refs.map((ref) => ref.reference),
      )
      .pipe(
        Effect.provideContext(context),
        Effect.timeoutOption(PROVIDER_READ_TIMEOUT),
        // A driver that dies is unavailable; its cause (which may hold what it read) is not logged.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          () =>
            Effect.logWarning("ProviderReads: a provider's read failed", {
              provider: plan.label,
              references: refs.length,
            }).pipe(Effect.as(Option.none<ReadonlyArray<SecretReadResult>>())),
        ),
        Effect.map(
          Option.match({
            onNone: () =>
              refs.map((): SecretReadResult => ({ _tag: "error", error: "unavailable" })),
            onSome: (results) =>
              refs.map(
                (_, index): SecretReadResult =>
                  results[index] ?? { _tag: "error", error: "unavailable" },
              ),
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
    const providers = yield* options.secretProviders;
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
      const plan = planOf(providers, ref.providerId);
      if (plan === undefined) {
        known({ _tag: "broken" });
        continue;
      }
      plans.set(ref.providerId, plan);
      if (
        referencePathProblem(ref.reference) !== undefined ||
        !plan.driver.definition.isReference(ref.reference) ||
        !allowedBy(ref.scopeId, ref.reference)
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

  return ProviderReads.of({ status, referenceProblem, read });
});

/** The Hub's: the built-in drivers and the Owner's settings, forgetting what a change replaced. */
export const layer = Layer.effect(
  ProviderReads,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const providers = settings.getSettings.pipe(
      Effect.map((current) => current.secretProviders),
      Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
    );
    return yield* make({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
      secretProviders: providers,
      changes: settings.streamChanges.pipe(Stream.map((current) => current.secretProviders)),
    });
  }),
);

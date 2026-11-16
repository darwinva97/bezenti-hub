/**
 * ProviderReads (ticket 02 of «Variables, Secretos sellados y Secret providers»): a fake driver
 * stands for a Secret provider. Reads are grouped and batched, bounded, held until they expire,
 * collapsed when concurrent, forgotten when the provider changes, and checked for path tricks.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SecretProviderId, SecretProviderKind, type ServerSettings } from "@t3tools/contracts";
import {
  defineSecretProviderDriver,
  readError,
  readValue,
  type SecretReadResult,
} from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderReads from "./ProviderReads.ts";

const FAKE = SecretProviderKind.make("fake");
const VAULT = SecretProviderId.make("vault");
const OTHER = SecretProviderId.make("other");

const providers = (
  account = "a",
  extra: ServerSettings["secretProviders"] = {},
): ServerSettings["secretProviders"] => ({
  [VAULT]: { kind: FAKE, label: "OpenBao", config: { account } },
  ...extra,
});

/** A fake provider: answers from `answer`, records each batch, may wait on `gate`. */
const fakeProvider = (
  answer: (account: string, reference: string) => SecretReadResult,
  gate: Effect.Effect<void> = Effect.void,
) => {
  const batches: Array<ReadonlyArray<string>> = [];
  const driver = defineSecretProviderDriver({
    kind: FAKE,
    definition: defineSecretProvider({
      kind: FAKE,
      label: "Fake",
      configSchema: Schema.Struct({ account: Schema.String }),
      isReference: (reference) => reference.startsWith("kv/"),
      referencePlaceholder: "kv/path#key",
      invalidReferenceMessage: "Use kv/path#key.",
    }),
    read: ({ account }, references) =>
      Effect.sync(() => batches.push(references)).pipe(
        Effect.andThen(gate),
        Effect.as(references.map((reference) => answer(account, reference))),
      ),
    test: () => Effect.succeed({ ok: true }),
  });
  return { driver, batches };
};

const reads = (
  driver: ReturnType<typeof fakeProvider>["driver"],
  settings: () => ServerSettings["secretProviders"] = () => providers(),
  changes?: Stream.Stream<ServerSettings["secretProviders"]>,
) =>
  ProviderReads.make({
    drivers: [driver],
    secretProviders: Effect.sync(settings),
    ...(changes === undefined ? {} : { changes }),
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const ref = (reference: string, providerId: string = VAULT) => ({
  providerId,
  scopeId: null,
  reference,
});

describe("ProviderReads", () => {
  it.effect("reads each provider once per batch and holds values until they expire", () =>
    Effect.gen(function* () {
      const { driver, batches } = fakeProvider((account, reference) =>
        reference === "kv/short"
          ? { _tag: "value", value: `${account}:short`, expiresAt: 60_000 }
          : readValue(`${account}:${reference}`),
      );
      const service = yield* reads(driver, () =>
        providers("a", { [OTHER]: { kind: FAKE, label: "Other", config: { account: "b" } } }),
      );
      const first = yield* service.read([
        ref("kv/a"),
        ref("kv/short"),
        ref("kv/a"),
        ref("kv/a", OTHER),
      ]);
      assert.deepEqual(
        first.map((outcome) => (outcome._tag === "value" ? outcome.value : outcome._tag)),
        ["a:kv/a", "a:short", "a:kv/a", "b:kv/a"],
      );
      assert.deepEqual(
        batches.map((batch) => [...batch]),
        [["kv/a", "kv/short"], ["kv/a"]],
      );
      // Held: no read until the value's own expiry, then until the refresh interval (5 min).
      yield* service.read([ref("kv/a"), ref("kv/short")]);
      assert.lengthOf(batches, 2);
      yield* TestClock.adjust("61 seconds");
      yield* service.read([ref("kv/a"), ref("kv/short")]);
      assert.deepEqual(batches.at(-1), ["kv/short"]);
      yield* TestClock.adjust("5 minutes");
      yield* service.read([ref("kv/a")]);
      assert.deepEqual(batches.at(-1), ["kv/a"]);
    }),
  );

  it.effect("a provider that does not answer in 10 s is unavailable; failures are not held", () =>
    Effect.gen(function* () {
      let hang = true;
      const { driver, batches } = fakeProvider(
        () => readValue("v"),
        Effect.suspend(() => (hang ? Effect.never : Effect.void)),
      );
      const service = yield* reads(driver);
      const reading = yield* service.read([ref("kv/a")]).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.deepEqual(yield* Fiber.join(reading), [
        { _tag: "error", error: "unavailable", label: "OpenBao" },
      ]);
      hang = false;
      assert.deepEqual(yield* service.read([ref("kv/a")]), [{ _tag: "value", value: "v" }]);
      assert.lengthOf(batches, 2);
    }),
  );

  it.effect("concurrent reads of one reference are one read", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const { driver, batches } = fakeProvider(() => readValue("v"), Deferred.await(release));
      const service = yield* reads(driver);
      const one = yield* service.read([ref("kv/a")]).pipe(Effect.forkChild);
      const two = yield* service.read([ref("kv/a")]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(yield* Fiber.join(one), [{ _tag: "value", value: "v" }]);
      assert.deepEqual(yield* Fiber.join(two), [{ _tag: "value", value: "v" }]);
      assert.lengthOf(batches, 1);
    }),
  );

  it.effect("a provider whose settings change, or go, is forgotten at once", () =>
    Effect.gen(function* () {
      let current = providers("a");
      const changes = yield* Queue.unbounded<ServerSettings["secretProviders"]>();
      const { driver, batches } = fakeProvider((account) => readValue(account));
      const service = yield* reads(driver, () => current, Stream.fromQueue(changes));
      yield* service.read([ref("kv/a")]);
      // Changed and changed back: what was held for the old settings is gone, read again.
      current = providers("b");
      yield* Queue.offer(changes, current);
      current = providers("a");
      yield* Queue.offer(changes, current);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.deepEqual(yield* service.read([ref("kv/a")]), [{ _tag: "value", value: "a" }]);
      assert.lengthOf(batches, 2);
      // Removed: broken, never read, nothing held for it.
      current = {};
      yield* Queue.offer(changes, current);
      yield* Effect.yieldNow;
      assert.deepEqual(yield* service.read([ref("kv/a")]), [{ _tag: "broken" }]);
      assert.deepEqual(yield* service.status(VAULT), { label: null, broken: true });
      current = providers("a");
      yield* service.read([ref("kv/a")]);
      assert.lengthOf(batches, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("a reference that leaves its path is refused at save and at read, never read", () =>
    Effect.gen(function* () {
      const { driver, batches } = fakeProvider(() => readValue("v"));
      const service = yield* reads(driver);
      for (const reference of [
        "kv/acme/../globex#token",
        "kv/acme//token",
        "kv/acme/%2e%2e/globex",
        "kv/acme%2Fglobex",
        "kv/acme\\globex",
        "kv/acme/\u0000",
        " kv/acme",
        "op/acme",
      ]) {
        assert.isDefined(yield* service.referenceProblem(ref(reference)), reference);
        assert.deepEqual(
          yield* service.read([ref(reference)]),
          [{ _tag: "error", error: "invalid", label: "OpenBao" }],
          reference,
        );
      }
      assert.lengthOf(batches, 0);
      assert.isUndefined(yield* service.referenceProblem(ref("kv/acme/app#token")));
      assert.isUndefined(ProviderReads.referencePathProblem("op://Private/OpenAI/credential"));
      assert.isDefined(yield* service.referenceProblem(ref("kv/a", "missing")));
    }),
  );

  it.effect("a failure says its class and provider, never what the provider said", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(JSON.stringify([options.message, String(options.cause)]));
    });
    return Effect.gen(function* () {
      const { driver } = fakeProvider(() => readError("forbidden"));
      const service = yield* reads(driver);
      assert.deepEqual(yield* service.read([ref("kv/a")]), [
        { _tag: "error", error: "forbidden", label: "OpenBao" },
      ]);
      // A driver that dies with a value in its cause: unavailable, and the cause is not logged.
      const dying = defineSecretProviderDriver({
        ...driver,
        definition: driver.definition,
        read: () => Effect.die(new Error("sk-leaked-in-a-defect")),
        test: () => Effect.succeed({ ok: true }),
      });
      const dyingReads = yield* reads(dying);
      const outcome = yield* dyingReads.read([ref("kv/a")]);
      assert.deepEqual(outcome, [{ _tag: "error", error: "unavailable", label: "OpenBao" }]);
      assert.notInclude(JSON.stringify(outcome) + logs.join(""), "sk-leaked-in-a-defect");
      assert.isAbove(logs.length, 0);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });
});

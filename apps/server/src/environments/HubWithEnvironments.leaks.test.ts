/**
 * Owned-resources 11, leak smoke: Ana's multi-line Secret and her own AI account's key, after a
 * turn that prints both and a terminal that prints half the Secret, are in no log, span, row,
 * process argument, Hub file or file of her machine but her Project's checkout. Every check is a
 * count or a boolean: a failure never prints a planted value.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the test reads files and /proc.
import { assert, describe, it } from "@effect/vitest";
import {
  type ProviderInstanceId,
  ProviderDriverKind,
  type SecretEnv,
  SpaceId,
  type ThreadId,
  UserId,
  type VaultGroupId,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { maskDeep } from "@t3tools/shared/secretMasking";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as AiAccounts from "../ai/AiAccounts.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { memberWithPasskey } from "./environments.testkit.ts";
import {
  awaitUploaded,
  createOrganization,
  loadFixture,
  replayOn,
} from "./HubWithEnvironments.scenarios.testkit.ts";
import {
  databaseText,
  hubCheckoutOf,
  hubFilesHolding,
  machineFilesHolding,
  processArgsHolding,
  threadWorkspaceOf,
} from "./HubWithEnvironments.secretMasking.testkit.ts";
import { makeHub } from "./HubWithEnvironments.testkit.ts";

const PEM_LINES = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCleak0101",
  "q2Ow3m1cZx5yJk7W8u9pQ2rSt4uVw6xYz8aBc0dEf1gHi2jKleak0202",
  "zZ9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF9eD8cB7aZ6yX5wleak0303",
  "-----END PRIVATE KEY-----",
];
const ANA_PEM = PEM_LINES.join("\n");
/** What must never show: the whole value and each line the masker covers on its own. */
const PEM_NEEDLES = [ANA_PEM, ...PEM_LINES.filter((line) => !line.startsWith("-----"))];
const ANA_KEY = "crsr-ana-own-direct-key-0123456789abcdef";
const NEEDLES = [...PEM_NEEDLES, ANA_KEY];

type Adapters = Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  McpProviderSessions.McpProviderSessions
>;

/** A Cursor-like agent that takes its secrets and key and prints them in its reply. */
const printingAll = (adapters: Adapters, seen: Array<SecretEnv | undefined>): Adapters =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: ProviderInstanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            driver: ProviderDriverKind.make("cursor"),
            acceptsAiCredential: ["CURSOR_API_KEY"],
            receivesSecretEnv: true as const,
            openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) => {
              seen.push(open.secretEnv);
              const { secretEnv: _secrets, ...recorded } = open;
              return adapter.openSession(recorded).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  events: runtime.events.pipe(
                    Stream.map((event) =>
                      maskDeep(event, (text) =>
                        text.replaceAll(
                          "fixture simple ok",
                          `key ${ANA_KEY}\n${ANA_PEM}\nhalf ${PEM_LINES[1]}`,
                        ),
                      ),
                    ),
                  ),
                })),
              );
            },
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

const holds = (text: string) => NEEDLES.filter((needle) => text.includes(needle)).length;

describe("Hub con Environments: Ana's Secret and AI key leak nowhere (owned-resources 11)", () => {
  it.live("after a turn and a terminal that print them", () => {
    const logs: Array<string> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const logger = Logger.make((options) => {
      logs.push(
        [options.message, options.cause, options.fiber.getRef(References.CurrentLogAnnotations)]
          .map((part) => {
            try {
              return JSON.stringify(part) ?? String(part);
            } catch {
              return String(part);
            }
          })
          .join(" "),
      );
    });
    return Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const seen: Array<SecretEnv | undefined> = [];
      const hub = yield* makeHub({ aiAccounts: true });
      // Ana: joined Acme once with a passkey and left it, so she has no Organization.
      const acme = yield* createOrganization(hub, "Acme");
      const joined = yield* memberWithPasskey(hub.server, hub.owner, {
        displayName: "Ana",
        spaceId: acme,
        role: "member",
      });
      const ana = UserId.make(joined.userId);
      yield* hub.server.sql`
        DELETE FROM space_memberships WHERE space_id = ${acme} AND user_id = ${ana}
      `;
      const asAna = CommandActor.actAs(ana);
      const [own] = yield* hub.server.sql<{ readonly groupId: VaultGroupId }>`
        SELECT group_id AS "groupId" FROM vault_groups
        WHERE owner_kind = 'user' AND owner_id = ${ana} AND is_default = 1
      `;
      assert.isDefined(own);
      yield* hub
        .service(Vaults.Vaults)
        .putEntry({ vaultId: own.groupId, name: "ANA_PEM", value: Redacted.make(ANA_PEM) })
        .pipe(asAna);
      yield* hub
        .service(AiAccounts.AiAccounts)
        .create({
          name: "Ana Cursor",
          type: "direct",
          provider: "cursor",
          apiKey: Redacted.make(ANA_KEY),
        })
        .pipe(asAna);
      const laptop = yield* hub.join({
        name: "Ana Laptop",
        adapters: printingAll(loaded.adapters, seen),
        as: { cookie: joined.cookie, authenticator: joined.authenticator },
      });
      // A turn in her Personal space, which prints the key and the Secret, whole and in part.
      yield* replayOn(hub, laptop, loaded, {
        ownerUserId: ana,
        spaceId: SpaceId.make(`personal:${ana}`),
      });
      const [threadId] = loaded.materialized.projectionThreadIds;
      assert.isDefined(threadId);
      yield* awaitUploaded(hub, threadId as ThreadId, 1);
      // Her process got both (so the checks below look for something that was there).
      const delivered = seen.flatMap((env) => env?.variables ?? []).map((v) => v.name);
      assert.includeMembers(delivered, ["ANA_PEM", "CURSOR_API_KEY"]);
      const projection = JSON.stringify(
        yield* hub.service(Orchestrator.OrchestratorV2).getThreadProjection(threadId as ThreadId),
      );
      assert.include(projection, "[ANA_PEM]", "the history names the Secret");
      assert.equal(holds(projection), 0, "the history holds a planted value");

      // A terminal that prints the Secret: the client sees `[ANA_PEM]`.
      const workspace = yield* threadWorkspaceOf(hub);
      const caller = { userId: ana };
      const cwd = yield* hubCheckoutOf(hub, threadId as ThreadId);
      yield* workspace.terminalOpen(
        { threadId: threadId as ThreadId, terminalId: "term-1", cwd, cols: 80, rows: 24 },
        caller,
      );
      const attached = yield* Deferred.make<void>();
      const frames = yield* Queue.unbounded<string>();
      yield* workspace
        .terminalAttach(
          { threadId: threadId as ThreadId, terminalId: "term-1" },
          "viewer-1",
          caller,
        )
        .pipe(
          Stream.runForEach((event) =>
            event.type === "snapshot"
              ? Deferred.succeed(attached, undefined)
              : event.type === "output"
                ? Queue.offer(frames, event.data)
                : Effect.void,
          ),
          Effect.forkScoped,
        );
      yield* Deferred.await(attached);
      yield* workspace.terminalWrite(
        { threadId: threadId as ThreadId, terminalId: "term-1", data: "echo $ANA_PEM\r" },
        caller,
      );
      const frame = yield* Queue.take(frames);
      assert.include(frame, "[ANA_PEM]");
      assert.equal(holds(frame), 0, "the terminal showed a planted value");

      // The smoke: counts only.
      const hubFiles = yield* Effect.forEach(NEEDLES, (needle) => hubFilesHolding(hub, needle));
      const laptopFiles = yield* Effect.forEach(NEEDLES, (needle) =>
        machineFilesHolding(laptop, needle),
      );
      const processes = yield* Effect.forEach(NEEDLES, (needle) => processArgsHolding(needle));
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ];
      assert.isAbove(spans.length, 0);
      assert.isAbove(logs.length, 0);
      assert.deepEqual(
        {
          hubFiles: hubFiles.flat().length,
          laptopFiles: laptopFiles.flat().length,
          processes: processes.flat().length,
          database: holds(yield* databaseText(hub)),
          logsAndSpans: recorded.filter((text) => holds(text) > 0).length,
        },
        { hubFiles: 0, laptopFiles: 0, processes: 0, database: 0, logsAndSpans: 0 },
      );
    }).pipe(
      Effect.scoped,
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  });
});

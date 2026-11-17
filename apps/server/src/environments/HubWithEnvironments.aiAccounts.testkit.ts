/**
 * AI accounts on the «Hub con Environments» testkit (spec 4 ticket 11): accounts allowed to Spaces
 * and Users, a fake agent CLI that calls the gateway with its session's key as it opens, and calls
 * to the gateway as an agent makes them (one held mid-stream, too).
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off -- a fake CLI on the relay's real port.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  AiAccountId,
  AiAccountProvider,
  ProviderInstanceId,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as AiAccounts from "../ai/AiAccounts.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as Grants from "../grants/Grants.ts";
import { activeAiGrants, lendAiAccount } from "../grants/Grants.testkit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { Hub } from "./HubWithEnvironments.testkit.ts";
import { ownerIdOf } from "./HubWithEnvironments.scenarios.testkit.ts";

/** A model the fake CLI asks the gateway for. */
export const GATEWAY_MODEL = "claude-sonnet-5-5";

/** What a provider process got when its session opened, and what its CLI got from the gateway. */
export interface OpenedSession {
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly aiGateway: ProviderAdapter.AiGatewaySessionInput | undefined;
  readonly answer: { readonly status: number; readonly text: string } | undefined;
}

const messagesBody = (stream: boolean) =>
  JSON.stringify({
    model: GATEWAY_MODEL,
    max_tokens: 16,
    stream,
    messages: [{ role: "user", content: "hi" }],
  });

const headersOf = (key: string) => ({
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
});

/** One call to the gateway through the relay, as Claude Code makes it with its key. */
export const callGateway = (baseUrl: string, key: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${baseUrl}/api/ai/anthropic/v1/messages`, {
      method: "POST",
      headers: headersOf(key),
      body: messagesBody(false),
    });
    return { status: response.status, text: await response.text() };
  });

/**
 * A streaming call held by the fake CLIProxyAPI after its first event until `release`: resolves
 * once that first event arrived, with the rest of the answer to wait for.
 */
export const heldStream = Effect.fn(function* (hub: Hub, baseUrl: string, key: string) {
  const dir = hub.aiGatewayDir;
  if (dir === undefined) return yield* Effect.die("the Hub runs no AI gateway");
  yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, "fake-stream-hold"), ""));
  const started = yield* Effect.promise(async () => {
    const response = await fetch(`${baseUrl}/api/ai/anthropic/v1/messages`, {
      method: "POST",
      headers: headersOf(key),
      body: messagesBody(true),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    let text = first.done ? "" : decoder.decode(first.value, { stream: true });
    const rest = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return { status: response.status, text };
    })();
    return { status: response.status, rest };
  });
  const release = Effect.promise(async () => {
    await NodeFSP.writeFile(NodePath.join(dir, "fake-stream-release"), "");
    const done = await started.rest;
    await NodeFSP.rm(NodePath.join(dir, "fake-stream-hold"), { force: true });
    await NodeFSP.rm(NodePath.join(dir, "fake-stream-release"), { force: true });
    return done;
  });
  return { status: started.status, release };
});

/**
 * A machine's adapters behind a fake CLI: each session on the gateway calls it through the relay
 * as soon as it opens, and notes what its process got. From the `failFrom`-th open on (0-based),
 * the CLI ends there once it called the gateway (a recorded transcript replays one session).
 */
export const fakeGatewayCli = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  opened: Array<OpenedSession>,
  options: { readonly failFrom?: number } = {},
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (id: ProviderInstanceId) =>
        registry.get(id).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            usesAiGateway: true as const,
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              Effect.gen(function* () {
                const gateway = input.aiGateway;
                const answer =
                  gateway?.baseUrl === undefined
                    ? undefined
                    : yield* callGateway(gateway.baseUrl, gateway.key);
                opened.push({
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  aiGateway: gateway,
                  answer,
                });
                if (options.failFrom !== undefined && opened.length > options.failFrom) {
                  return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: adapter.driver,
                    providerSessionId: input.providerSessionId,
                    cause: "the fake CLI ends here",
                  });
                }
                const { aiGateway: _gateway, ...recorded } = input;
                return yield* adapter.openSession(recorded);
              }),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/** An AI account of the Owner's on the gateway, serving `models`, lent to Spaces and Users. */
export const addGatewayAccount = Effect.fn(function* (
  hub: Hub,
  name: string,
  allow: { readonly spaceIds?: ReadonlyArray<SpaceId>; readonly userIds?: ReadonlyArray<UserId> },
  models: ReadonlyArray<string>,
) {
  const owner = yield* ownerIdOf(hub);
  const accounts = hub.service(AiAccounts.AiAccounts);
  const made = yield* accounts
    .create({
      name,
      provider: "openai-compatible" as AiAccountProvider,
      apiKey: Redacted.make(`sk-test-${name.replaceAll(" ", "-")}-0123456789abcdef`),
      baseUrl: "http://127.0.0.1:9/v1",
      models: [...models],
    } as never)
    .pipe(CommandActor.actAs(owner), Effect.orDie);
  yield* lendAccount(hub, made.id, allow);
  return made.id;
});

/** A direct AI account of the Owner's (a Cursor key), lent to Spaces and Users. */
export const addDirectAccount = Effect.fn(function* (
  hub: Hub,
  name: string,
  key: string,
  allow: { readonly spaceIds?: ReadonlyArray<SpaceId>; readonly userIds?: ReadonlyArray<UserId> },
) {
  const owner = yield* ownerIdOf(hub);
  const made = yield* hub
    .service(AiAccounts.AiAccounts)
    .create({ name, type: "direct", provider: "cursor", apiKey: Redacted.make(key) })
    .pipe(CommandActor.actAs(owner), Effect.orDie);
  yield* lendAccount(hub, made.id, allow);
  return made.id;
});

/**
 * Lends the Owner's account to exactly these Spaces (and these Users' Personal spaces, none to the
 * Owner's own: it is theirs there), as migration 145 turned allowances into Grants. Loans to other
 * Spaces are taken back through Grants, as the Owner does in Settings.
 */
export const lendAccount = Effect.fn(function* (
  hub: Hub,
  accountId: AiAccountId,
  to: { readonly spaceIds?: ReadonlyArray<SpaceId>; readonly userIds?: ReadonlyArray<UserId> },
) {
  const owner = yield* ownerIdOf(hub);
  const wanted = new Set<string>([
    ...(to.spaceIds ?? []),
    ...(to.userIds ?? [])
      .filter((userId) => userId !== owner)
      .map((userId) => `personal:${userId}`),
  ]);
  const grants = hub.service(Grants.Grants);
  const live = yield* activeAiGrants(hub.server.sql, accountId).pipe(Effect.orDie);
  for (const grant of live) {
    if (wanted.delete(grant.spaceId)) continue;
    yield* grants.end({ grantId: grant.grantId }).pipe(CommandActor.actAs(owner), Effect.orDie);
  }
  for (const spaceId of wanted) {
    yield* lendAiAccount(hub.server.sql, {
      accountId,
      lender: { kind: "user", id: owner },
      spaceId,
    }).pipe(Effect.orDie);
  }
});

/** Waits (bounded) until `check` holds, re-run every 25 ms. */
export const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, within = 10_000) =>
  Effect.gen(function* () {
    for (let waited = 0; waited < within; waited += 25) {
      if (yield* check) return true;
      yield* Effect.sleep(25);
    }
    return yield* check;
  });

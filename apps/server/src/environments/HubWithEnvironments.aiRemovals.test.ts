/**
 * Spec 4 ticket 11, removals: a User removed, an allowance taken back or an Organization deleted
 * drops what can no longer be reached (gateway keys, allowances, live processes holding a direct
 * credential or a key) in the write that ends the reach, or at the next check.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type AiAccountId,
  CommandId,
  type OrchestrationV2Command,
  ProviderDriverKind,
  type ProviderInstanceId,
  ProviderSessionId,
  type SecretEnv,
  type SpaceId,
  type ThreadId,
  UserId,
  sandboxEnvironmentIdOf,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as AiAccounts from "../ai/AiAccounts.ts";
import * as AiGatewayKeys from "../ai/AiGatewayKeys.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import * as AiSessionReach from "../orchestration-v2/AiSessionReach.ts";
import * as InstallationUserService from "../spaces/InstallationUserService.ts";
import * as MembershipService from "../spaces/MembershipService.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import {
  addDirectAccount,
  addGatewayAccount,
  allowAccount,
  callGateway,
  eventually,
  fakeGatewayCli,
  GATEWAY_MODEL,
  type OpenedSession,
} from "./HubWithEnvironments.aiAccounts.testkit.ts";
import {
  createOrganization,
  type LoadedFixture,
  loadFixture,
  ownerIdOf,
  replayOn,
  startSandbox,
} from "./HubWithEnvironments.scenarios.testkit.ts";
import type { Hub, TestEnvironment } from "./HubWithEnvironments.testkit.ts";
import { makeHub } from "./HubWithEnvironments.testkit.ts";

type Adapters = Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  McpProviderSessions.McpProviderSessions
>;

const CURSOR_KEY = "crsr-acme-removal-key-0123456789abcdef";

/** A machine's adapters as Cursor's, taking a direct `CURSOR_API_KEY`, noted as they open. */
const asCursor = (adapters: Adapters, seen: Array<SecretEnv | undefined>): Adapters =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (id: ProviderInstanceId) =>
        registry.get(id).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            driver: ProviderDriverKind.make("cursor"),
            acceptsAiCredential: ["CURSOR_API_KEY"],
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) => {
              seen.push(input.secretEnv);
              const { secretEnv: _secrets, ...recorded } = input;
              return adapter.openSession(recorded);
            },
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/** The fixture's Thread run once on `environment` (its session stays open), for `ownerUserId`. */
const replayedThread = Effect.fn(function* (
  hub: Hub,
  environment: Pick<TestEnvironment, "environmentId">,
  loaded: LoadedFixture,
  input: {
    readonly spaceId: SpaceId;
    readonly ownerUserId: UserId;
    readonly aiAccountId?: AiAccountId;
  },
) {
  yield* replayOn(hub, environment as TestEnvironment, loaded, input);
  const create = loaded.materialized.commands.find((command) => command.type === "thread.create");
  if (create?.type !== "thread.create") return yield* Effect.die("no thread.create");
  const threadId: ThreadId = create.threadId;
  if (input.aiAccountId !== undefined) {
    const now = yield* hub
      .service(Orchestrator.OrchestratorV2)
      .getThreadProjection(threadId)
      .pipe(Effect.orDie);
    yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make(`choose:${threadId}`),
      threadId,
      modelSelection: { ...now.thread.modelSelection, aiAccountId: input.aiAccountId },
    } as OrchestrationV2Command);
  }
  const [session] = yield* hub.server.sql<{ readonly id: string }>`
    SELECT provider_session_id AS id FROM orchestration_v2_projection_provider_sessions
    WHERE thread_id = ${threadId}
  `;
  assert.isDefined(session, "the turn's session");
  return { threadId, providerSessionId: session.id };
});

const isClosed = (hub: Hub, providerSessionId: string) =>
  hub
    .service(ProviderSessionManagerV2)
    .isLive(ProviderSessionId.make(providerSessionId))
    .pipe(Effect.map((live) => !live));

/** Ada, a Member of Acme. */
const withAda = Effect.fn(function* (hub: Hub, acme: SpaceId) {
  yield* addMember(hub.server, { id: "ada", displayName: "Ada" });
  yield* joinOrganization(hub.server, acme, "ada", "member");
  const ada = UserId.make("ada");
  yield* hub.service(SpaceDirectory.SpaceDirectory).membershipsChanged([ada]);
  return ada;
});

const auditsOf = (hub: Hub, action: string) =>
  hub.server.sql<{
    readonly actor: string | null;
    readonly target: string;
    readonly detail: string;
  }>`
    SELECT actor_user_id AS actor, target_id AS target, detail_json AS detail
    FROM audit_log WHERE action = ${action} ORDER BY rowid
  `;

describe("Hub con Environments: removals drop what an AI account no longer reaches (spec 4 ticket 11)", () => {
  it.live(
    "a removed User's keys (Thread and local CLI) answer 401 at once, revoked and audited in the removal's commit; allowances to them go; their process closes",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const opened: Array<OpenedSession> = [];
        const hub = yield* makeHub({
          aiAccounts: true,
          sandboxAdapters: fakeGatewayCli(loaded.adapters, opened, { failFrom: 1 }),
        });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const ada = yield* withAda(hub, acme);
        const models = [GATEWAY_MODEL, loaded.variant.modelSelection.model];
        yield* addGatewayAccount(hub, "Acme Claude", { spaceIds: [acme] }, models);
        const adaAccount = yield* addGatewayAccount(hub, "Ada Claude", { userIds: [ada] }, models);
        yield* startSandbox(hub, acme);
        const thread = yield* replayedThread(
          hub,
          { environmentId: sandboxEnvironmentIdOf(acme) },
          loaded,
          { spaceId: acme, ownerUserId: ada },
        );
        const threadKey = opened[0]!.aiGateway!;
        assert.equal(opened[0]?.answer?.status, 200, opened[0]?.answer?.text);
        const cliKey = yield* hub
          .service(AiGatewayKeys.AiGatewayKeys)
          .createForUser({ actorUserId: ada, spaceId: acme, name: "Laptop CLI" })
          .pipe(Effect.orDie);
        const cliBefore = yield* callGateway(hub.server.url, Redacted.value(cliKey.key));
        assert.equal(cliBefore.status, 200, cliBefore.text);

        yield* hub
          .service(InstallationUserService.InstallationUserService)
          .setStatus({ actorUserId: owner, userId: ada, status: "removed" })
          .pipe(Effect.orDie);

        // Revoked in the removal's own commit, not by a watch afterwards.
        const live = yield* hub.server.sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM ai_gateway_keys WHERE user_id = ${ada} AND revoked_at IS NULL
        `;
        assert.equal(live[0]?.n, 0);
        const revoked = yield* auditsOf(hub, "ai_gateway_key.revoke");
        assert.deepEqual(
          revoked.map((row) => [row.actor, row.target]),
          [[owner, cliKey.keyId]],
          "the local CLI key's revocation is audited as the Owner's",
        );
        assert.equal(
          (yield* callGateway(threadKey.baseUrl!, threadKey.key)).status,
          401,
          "the Thread key",
        );
        assert.equal(
          (yield* callGateway(hub.server.url, Redacted.value(cliKey.key))).status,
          401,
          "the local CLI key",
        );
        // Nothing stays allowed to them, audited as taken back.
        const allowances = yield* hub.server.sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM ai_account_allowances
          WHERE subject_id IN (${ada}, ${`personal:${ada}`})
        `;
        assert.equal(allowances[0]?.n, 0);
        const taken = (yield* auditsOf(hub, "ai_account.allow")).filter(
          (row) => row.target === adaAccount && row.detail.includes('"removed":1'),
        );
        assert.lengthOf(taken, 1);
        assert.isTrue(
          yield* eventually(isClosed(hub, thread.providerSessionId)),
          "the process started for them closes",
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "an allowance taken back closes the process holding that account's direct key, also on a machine that was away",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const account = yield* addDirectAccount(hub, "Acme Cursor", CURSOR_KEY, {
          spaceIds: [acme],
        });
        const seen: Array<SecretEnv | undefined> = [];
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: asCursor(loaded.adapters, seen),
        });
        const thread = yield* replayedThread(hub, laptop, loaded, {
          spaceId: acme,
          ownerUserId: owner,
          aiAccountId: account,
        });
        assert.equal(
          seen[0]?.variables?.find((variable) => variable.name === "CURSOR_API_KEY")?.value,
          CURSOR_KEY,
        );
        // Away while the Owner takes the account back from Acme.
        yield* laptop.disconnect;
        const from = laptop.requests.length;
        yield* allowAccount(hub, account, {});
        assert.isTrue(
          yield* eventually(isClosed(hub, thread.providerSessionId)),
          "the Hub closes the session at once",
        );
        // Back: the machine is told to end the process.
        yield* laptop.connect;
        yield* laptop.awaitRequest("provider.detach", from);
      }).pipe(Effect.scoped),
  );

  it.live(
    "a Member taken out of Acme loses Acme's own account: the process holding its direct key closes (owned-resources 10)",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const seen: Array<SecretEnv | undefined> = [];
        const hub = yield* makeHub({
          aiAccounts: true,
          sandboxAdapters: asCursor(loaded.adapters, seen),
        });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const ada = yield* withAda(hub, acme);
        // Acme's own account, not an allowance of the Owner's.
        const account = yield* hub
          .service(AiAccounts.AiAccounts)
          .create({
            name: "Acme Cursor",
            type: "direct",
            provider: "cursor",
            apiKey: Redacted.make(CURSOR_KEY),
            owner: { kind: "organization", spaceId: acme },
          })
          .pipe(CommandActor.actAs(owner), Effect.orDie);
        yield* startSandbox(hub, acme);
        const thread = yield* replayedThread(
          hub,
          { environmentId: sandboxEnvironmentIdOf(acme) },
          loaded,
          { spaceId: acme, ownerUserId: ada, aiAccountId: account.id },
        );
        assert.isTrue(
          seen.some((env) =>
            (env?.variables ?? []).some((variable) => variable.name === "CURSOR_API_KEY"),
          ),
          "her process got Acme's key",
        );
        // As «Remove from organization» does it, by the Owner.
        yield* hub
          .service(MembershipService.MembershipService)
          .remove({ actor: owner, spaceId: acme, userId: ada })
          .pipe(Effect.orDie);
        // The check a Membership change asks for. This kit builds the orchestration apart, with
        // its own Space directory, so the change itself does not reach it here; the server
        // builds one directory for both.
        yield* hub.service(AiSessionReach.AiSessionReach).request;
        assert.isTrue(
          yield* eventually(isClosed(hub, thread.providerSessionId)),
          "her process holding Acme's key closes",
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "deleting an Organization revokes the local CLI keys made for it and drops its allowances, audited",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const ada = yield* withAda(hub, acme);
        const account = yield* addGatewayAccount(hub, "Acme Claude", { spaceIds: [acme] }, [
          GATEWAY_MODEL,
        ]);
        const cliKey = yield* hub
          .service(AiGatewayKeys.AiGatewayKeys)
          .createForUser({ actorUserId: ada, spaceId: acme, name: "Laptop CLI" })
          .pipe(Effect.orDie);
        const organizations = hub.service(OrganizationLifecycle.OrganizationLifecycle);
        yield* organizations.archive(owner, acme).pipe(Effect.orDie);
        yield* organizations.delete(owner, acme).pipe(Effect.orDie);

        const [key] = yield* hub.server.sql<{ readonly reason: string | null }>`
          SELECT revoked_reason AS reason FROM ai_gateway_keys WHERE key_id = ${cliKey.keyId}
        `;
        assert.equal(key?.reason, "space-lost");
        const allowances = yield* hub.server.sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM ai_account_allowances WHERE subject_id = ${acme}
        `;
        assert.equal(allowances[0]?.n, 0);
        const audits = yield* auditsOf(hub, "ai_account.allow");
        assert.isTrue(
          audits.some((row) => row.target === account && row.actor === owner),
          "the allowance taken back is audited",
        );
        assert.equal(
          (yield* callGateway(hub.server.url, Redacted.value(cliKey.key))).status,
          403,
          "its holder is told the Space is gone",
        );
      }).pipe(Effect.scoped),
  );
});

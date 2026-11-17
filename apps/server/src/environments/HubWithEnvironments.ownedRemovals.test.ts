/**
 * Owned-resources 10: what a removed User or deleted Organization owns goes with them (Vault,
 * AI accounts, loans); disabling or archiving deletes nothing. Planted values are only ever
 * checked as booleans.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type AiAccountId,
  type AiAccountProvider,
  ProviderDriverKind,
  ProviderInstanceId,
  type SpaceId,
  UserId,
  type VaultGroupId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as AiAccounts from "../ai/AiAccounts.ts";
import * as AiGateway from "../ai/AiGateway.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as InstallationUserService from "../spaces/InstallationUserService.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import { orgOwner, userOwner } from "../vaults/VaultGroups.testkit.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { eventually, GATEWAY_MODEL } from "./HubWithEnvironments.aiAccounts.testkit.ts";
import { createOrganization, ownerIdOf } from "./HubWithEnvironments.scenarios.testkit.ts";
import { type Hub, makeHub } from "./HubWithEnvironments.testkit.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");
/** A provider that runs no turn: these tests run none. */
const idleAdapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId: INSTANCE,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no turns run here"),
  },
]);

const ANA_DEFAULT_SECRET = "ana-default-secret-value-0101";
const ANA_TOOLS_SECRET = "ana-tools-secret-value-0202";
const ACME_SECRET = "acme-own-secret-value-0303";

/** The prefixes CLIProxyAPI holds now, as its Management API answers them. */
const gatewayPrefixes = (hub: Hub) =>
  Effect.gen(function* () {
    const endpoint = yield* hub.service(AiGateway.AiGateway).endpoint;
    if (Option.isNone(endpoint)) return yield* Effect.die("the gateway is not running");
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${endpoint.value.baseUrl}/v8/management/config`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(endpoint.value.managementKey)),
      ),
    );
    const config = (yield* response.json) as {
      readonly "api-keys"?: Record<string, ReadonlyArray<{ readonly prefix: string }>>;
    };
    return Object.values(config["api-keys"] ?? {})
      .flat()
      .map((entry) => entry.prefix);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie);

const inGateway = (hub: Hub, accountId: AiAccountId) =>
  gatewayPrefixes(hub).pipe(Effect.map((prefixes) => prefixes.includes(`acct-${accountId}`)));

/** An API-key account owned by whoever acts. */
const addAccount = (hub: Hub, actor: UserId, name: string, owner?: unknown) =>
  hub
    .service(AiAccounts.AiAccounts)
    .create({
      name,
      provider: "openai-compatible" as AiAccountProvider,
      apiKey: Redacted.make(`sk-test-${name.replaceAll(" ", "-")}-0123456789abcdef`),
      baseUrl: "http://127.0.0.1:9/v1",
      models: [GATEWAY_MODEL],
      ...(owner === undefined ? {} : { owner }),
    } as never)
    .pipe(
      CommandActor.actAs(actor),
      Effect.orDie,
      Effect.map((made) => made.id),
    );

/** Whether each value is still held by the Hub's sealed store (booleans only). */
const stored = (hub: Hub, valueIds: ReadonlyArray<string>) =>
  Effect.forEach(valueIds, (valueId) =>
    hub
      .service(ServerSecretStore.VaultValueStore)
      .get(valueId)
      .pipe(Effect.orDie, Effect.map(Option.isSome)),
  );

const groupsOf = (hub: Hub, ownerKind: string, ownerId: string) =>
  hub.server.sql<{ readonly groupId: string }>`
    SELECT group_id AS "groupId" FROM vault_groups
    WHERE owner_kind = ${ownerKind} AND owner_id = ${ownerId}
  `.pipe(Effect.map((rows) => rows.map((row) => row.groupId)));

const valueIdsOf = (hub: Hub, groupIds: ReadonlyArray<string>) =>
  hub.server.sql<{ readonly valueId: string }>`
    SELECT value_id AS "valueId" FROM vault_entries
    WHERE value_id IS NOT NULL AND ${hub.server.sql.in("group_id", groupIds)}
  `.pipe(Effect.map((rows) => rows.map((row) => row.valueId)));

/** Rows anywhere that still name one of these groups. */
const rowsNaming = (hub: Hub, groupIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = hub.server.sql;
    let n = 0;
    for (const table of [
      "vault_groups",
      "vault_entries",
      "vault_allowances",
      "space_default_vaults",
      "project_vault_choices",
      "vault_provider_scopes",
    ]) {
      const [row] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ${sql.literal(table)} WHERE ${sql.in("group_id", groupIds)}
      `;
      n += row?.n ?? 0;
    }
    return n;
  });

const accountRows = (hub: Hub, ownerKind: string, ownerId: string) =>
  hub.server.sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM ai_accounts WHERE owner_kind = ${ownerKind} AND owner_id = ${ownerId}
  `.pipe(Effect.map((rows) => rows[0]?.n ?? 0));

const auditVia = (hub: Hub, action: string, via: string) =>
  hub.server.sql<{ readonly target: string }>`
    SELECT target_id AS target FROM audit_log
    WHERE action = ${action} AND json_extract(detail_json, '$.via') = ${via}
    ORDER BY rowid
  `.pipe(Effect.map((rows) => rows.map((row) => row.target)));

/** Ana (no Organization) with her `default` and a named group, a Secret in each, and an account. */
const withAna = Effect.fn(function* (hub: Hub) {
  yield* addMember(hub.server, { id: "ana", displayName: "Ana" });
  const ana = UserId.make("ana");
  const vaults = hub.service(Vaults.Vaults);
  const asAna = CommandActor.actAs(ana);
  const tools = yield* vaults
    .create({ name: "Ana tools", owner: userOwner(ana) })
    .pipe(asAna, Effect.orDie);
  const [defaultGroup] = yield* hub.server.sql<{ readonly groupId: VaultGroupId }>`
    SELECT group_id AS "groupId" FROM vault_groups
    WHERE owner_kind = 'user' AND owner_id = ${ana} AND is_default = 1
  `;
  assert.isDefined(defaultGroup, "Ana's default group");
  yield* vaults
    .putEntry({
      vaultId: defaultGroup.groupId,
      name: "ANA_TOKEN",
      value: Redacted.make(ANA_DEFAULT_SECRET),
    })
    .pipe(asAna, Effect.orDie);
  yield* vaults
    .putEntry({ vaultId: tools.id, name: "ANA_TOOLS_KEY", value: Redacted.make(ANA_TOOLS_SECRET) })
    .pipe(asAna, Effect.orDie);
  const account = yield* addAccount(hub, ana, "Ana Claude");
  return { ana, account };
});

/** Loans of every kind on Ana's side, written as Grants would: kind-agnostic ending. */
const seedLoans = Effect.fn(function* (hub: Hub, ana: UserId, account: AiAccountId, acme: SpaceId) {
  const owner = yield* ownerIdOf(hub);
  const at = "2026-01-01T00:00:00.000Z";
  const insert = (row: {
    readonly id: string;
    readonly kind: string;
    readonly resourceId: string;
    readonly lender: string;
    readonly target: string | null;
    readonly state: string;
  }) => hub.server.sql`
    INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
      target_kind, target_id, state, limits_json, created_at)
    VALUES (${row.id}, ${row.kind}, ${row.resourceId}, 'user', ${row.lender}, 'space',
      ${row.target}, ${row.state}, '{}', ${at})
  `;
  yield* insert({
    id: "grant-ana-account",
    kind: "ai-account",
    resourceId: account,
    lender: ana,
    target: acme,
    state: "active",
  });
  yield* insert({
    id: "grant-ana-offer",
    kind: "ai-account",
    resourceId: account,
    lender: ana,
    target: null,
    state: "offered",
  });
  yield* insert({
    id: "grant-to-ana",
    kind: "vault-group",
    resourceId: "owner-group",
    lender: owner,
    target: `personal:${ana}`,
    state: "pending",
  });
});

const grantStates = (hub: Hub) =>
  hub.server.sql<{ readonly id: string; readonly state: string; readonly reason: string | null }>`
    SELECT grant_id AS id, state, end_reason AS reason FROM grants ORDER BY grant_id
  `.pipe(Effect.map((rows) => rows.map((row) => [row.id, row.state, row.reason])));

describe("Hub con Environments: owned resources go with their owner (owned-resources 10)", () => {
  it.live(
    "disabling Ana keeps her Vault and AI account; removing her deletes them, values and gateway key included, and ends her loans",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const { ana, account } = yield* withAna(hub);
        yield* seedLoans(hub, ana, account, acme);
        const groups = yield* groupsOf(hub, "user", ana);
        assert.lengthOf(groups, 2);
        const valueIds = yield* valueIdsOf(hub, groups);
        assert.lengthOf(valueIds, 2);
        assert.isTrue(yield* eventually(inGateway(hub, account)), "her account is in the gateway");
        const users = hub.service(InstallationUserService.InstallationUserService);
        const setStatus = (status: "active" | "disabled" | "removed") =>
          users.setStatus({ actorUserId: owner, userId: ana, status }).pipe(Effect.orDie);

        // Disabled, then back: nothing of hers was deleted.
        yield* setStatus("disabled");
        yield* setStatus("active");
        assert.deepEqual(yield* groupsOf(hub, "user", ana), groups);
        assert.deepEqual(yield* stored(hub, valueIds), [true, true]);
        assert.equal(yield* accountRows(hub, "user", ana), 1);
        assert.isTrue(yield* inGateway(hub, account), "her account is still in the gateway");
        assert.deepEqual(yield* grantStates(hub), [
          ["grant-ana-account", "active", null],
          ["grant-ana-offer", "offered", null],
          ["grant-to-ana", "pending", null],
        ]);

        yield* setStatus("removed");
        // Her Vault: no row names her groups, and their values left the sealed store.
        assert.equal(yield* rowsNaming(hub, groups), 0);
        assert.deepEqual(yield* stored(hub, valueIds), [false, false]);
        // Her account: out of CLIProxyAPI, then out of the database.
        assert.isTrue(
          yield* eventually(inGateway(hub, account).pipe(Effect.map((held) => !held))),
          "her account left the gateway",
        );
        assert.isTrue(
          yield* eventually(accountRows(hub, "user", ana).pipe(Effect.map((n) => n === 0))),
          "her account's row went once the gateway let it go",
        );
        // Her loans end, the link she offered expires, the one to her Personal space ends.
        assert.deepEqual(yield* grantStates(hub), [
          ["grant-ana-account", "ended", "lender-gone"],
          ["grant-ana-offer", "offered", null],
          ["grant-to-ana", "ended", "target-gone"],
        ]);
        const [offer] = yield* hub.server.sql<{ readonly expired: number }>`
          SELECT offer_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS expired FROM grants
          WHERE grant_id = 'grant-ana-offer'
        `;
        assert.equal(offer?.expired, 1, "her link expired");
        // Each audited with how it went.
        assert.include(yield* auditVia(hub, "ai_account.delete", "user.remove"), account);
        assert.sameMembers(yield* auditVia(hub, "vault_group.delete", "user.remove"), groups);
        assert.sameMembers(yield* auditVia(hub, "grant.end", "user.remove"), [
          "grant-ana-account",
          "grant-to-ana",
        ]);
        assert.deepEqual(yield* auditVia(hub, "grant.cancel", "user.remove"), ["grant-ana-offer"]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "deleting Acme deletes its Vault and AI accounts; its dedicated machine stays for the Owner",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const owner = yield* ownerIdOf(hub);
        const asOwner = CommandActor.actAs(owner);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const vaults = hub.service(Vaults.Vaults);
        const keys = yield* vaults
          .create({ name: "Acme keys", owner: orgOwner(acme) })
          .pipe(asOwner, Effect.orDie);
        yield* vaults
          .putEntry({ vaultId: keys.id, name: "ACME_TOKEN", value: Redacted.make(ACME_SECRET) })
          .pipe(asOwner, Effect.orDie);
        const acmeAccount = yield* addAccount(hub, owner, "Acme Claude", {
          kind: "organization",
          spaceId: acme,
        });
        const globexAccount = yield* addAccount(hub, owner, "Globex Claude", {
          kind: "organization",
          spaceId: globex,
        });
        const groups = yield* groupsOf(hub, "organization", acme);
        const valueIds = yield* valueIdsOf(hub, groups);
        assert.lengthOf(valueIds, 1);
        const machine = yield* hub.join({ name: "Acme VPS", adapters: idleAdapters });
        yield* hub.server.sql`
          UPDATE environments SET mode = 'dedicated', space_id = ${acme}, owner_user_id = NULL
          WHERE environment_id = ${machine.environmentId}
        `;
        assert.isTrue(yield* eventually(inGateway(hub, acmeAccount)));

        const organizations = hub.service(OrganizationLifecycle.OrganizationLifecycle);
        yield* organizations.archive(owner, acme).pipe(Effect.orDie);
        // Archived: nothing of it is deleted.
        assert.equal(yield* accountRows(hub, "organization", acme), 1);
        assert.deepEqual(yield* stored(hub, valueIds), [true]);
        yield* organizations.delete(owner, acme).pipe(Effect.orDie);

        assert.equal(yield* rowsNaming(hub, groups), 0);
        assert.deepEqual(yield* stored(hub, valueIds), [false]);
        assert.isTrue(
          yield* eventually(inGateway(hub, acmeAccount).pipe(Effect.map((held) => !held))),
          "Acme's account left the gateway",
        );
        assert.isTrue(
          yield* eventually(
            accountRows(hub, "organization", acme).pipe(Effect.map((n) => n === 0)),
          ),
        );
        assert.include(
          yield* auditVia(hub, "ai_account.delete", "organization.delete"),
          acmeAccount,
        );
        // Globex's account is untouched.
        assert.isTrue(yield* inGateway(hub, globexAccount));
        assert.equal(yield* accountRows(hub, "organization", globex), 1);
        // The dedicated machine stays, for the Owner to see and remove.
        const [kept] = yield* hub.server.sql<{ readonly revoked: string | null }>`
          SELECT revoked_at AS revoked FROM environments
          WHERE environment_id = ${machine.environmentId}
        `;
        assert.isDefined(kept);
        assert.isNull(kept.revoked);
      }).pipe(Effect.scoped),
  );
});

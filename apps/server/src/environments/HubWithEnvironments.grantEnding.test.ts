/**
 * Grants ticket 11: a loan ends by itself when its resource is deleted, its destination Space is
 * deleted or its lender is gone, through the path «Take back» takes, in the removal's transaction:
 * nothing reaches the Space afterwards, `grant.end` is audited with the reason, and both sides
 * still see the ended loan by name. Archiving the Space or the lender leaving it ends nothing.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type AiAccountId,
  type AiAccountProvider,
  type Grant,
  type GrantId,
  type SpaceId,
  UserId,
  type VaultGroupId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as AiAccounts from "../ai/AiAccounts.ts";
import * as AllowedAiAccounts from "../ai/AllowedAiAccounts.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as Grants from "../grants/Grants.ts";
import { lendAiAccount, lendVaultGroup } from "../grants/Grants.testkit.ts";
import * as InstallationUserService from "../spaces/InstallationUserService.ts";
import * as MembershipService from "../spaces/MembershipService.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { userOwner } from "../vaults/VaultGroups.testkit.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { eventually, GATEWAY_MODEL } from "./HubWithEnvironments.aiAccounts.testkit.ts";
import { createOrganization, ownerIdOf } from "./HubWithEnvironments.scenarios.testkit.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { type Hub, makeHub } from "./HubWithEnvironments.testkit.ts";

const NO_CAP = { kind: "ai-account", tokens: null, requests: null } as const;

/** Acme (Adam its Admin, Mia a Member, Ana a Member) and Globex, run by the Owner. */
const cast = Effect.fn(function* (hub: Hub) {
  const owner = yield* ownerIdOf(hub);
  const acme = yield* createOrganization(hub, "Acme");
  const globex = yield* createOrganization(hub, "Globex");
  for (const [id, role] of [
    ["adam", "admin"],
    ["mia", "member"],
    ["ana", "member"],
  ] as const) {
    yield* addMember(hub.server, { id, displayName: id[0]?.toUpperCase() + id.slice(1) });
    yield* joinOrganization(hub.server, acme, id, role);
  }
  yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .membershipsChanged([UserId.make("adam"), UserId.make("mia"), UserId.make("ana")]);
  return {
    owner,
    acme,
    globex,
    adam: UserId.make("adam"),
    mia: UserId.make("mia"),
    ana: UserId.make("ana"),
  };
});

/** An API-key account of `owner`, added by `actor`. */
const addAccount = (
  hub: Hub,
  actor: UserId,
  name: string,
  owner?: { readonly kind: "organization"; readonly spaceId: SpaceId },
) =>
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
      Effect.map((made) => made.id as AiAccountId),
    );

/** The AI accounts `userId` may use in `spaceId`, by id. */
const reachedAccounts = (hub: Hub, userId: UserId, spaceId: SpaceId) =>
  hub
    .service(AllowedAiAccounts.AllowedAiAccounts)
    .for(userId, spaceId)
    .pipe(
      Effect.orDie,
      Effect.map((accounts) => accounts.map((account) => account.id as string)),
    );

/** The groups lent to a Space `userId` works in, as their Vault list shows them. */
const borrowedGroups = (hub: Hub, userId: UserId) =>
  hub.service(Vaults.Vaults).list.pipe(
    CommandActor.actAs(userId),
    Effect.orDie,
    Effect.map((list) =>
      list.groups.filter((group) => group.borrowed !== undefined).map((group) => group.id),
    ),
  );

const stateOf = (hub: Hub, grantId: string) =>
  hub.server.sql<{ readonly state: string; readonly reason: string | null }>`
    SELECT state, end_reason AS reason FROM grants WHERE grant_id = ${grantId}
  `.pipe(Effect.map((rows) => [rows[0]?.state, rows[0]?.reason ?? null]));

/** `grant.end` / `grant.cancel` audits of a loan: action, reason, side and via. */
const auditsOf = (hub: Hub, grantId: string) =>
  hub.server.sql<{ readonly action: string; readonly detail: string }>`
    SELECT action, detail_json AS detail FROM audit_log
    WHERE target_kind = 'grant' AND target_id = ${grantId}
      AND action IN ('grant.end', 'grant.cancel')
    ORDER BY rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const detail = JSON.parse(row.detail) as Record<string, unknown>;
        return [row.action, detail.reason ?? null, detail.side ?? null, detail.via ?? null];
      }),
    ),
  );

const given = (hub: Hub, userId: UserId) =>
  hub.service(Grants.Grants).listGiven.pipe(
    CommandActor.actAs(userId),
    Effect.orDie,
    Effect.map((list) => list.grants),
  );

const received = (hub: Hub, userId: UserId, spaceId: SpaceId) =>
  hub
    .service(Grants.Grants)
    .listReceived({ spaceId })
    .pipe(
      CommandActor.actAs(userId),
      Effect.orDie,
      Effect.map((list) => list.grants),
    );

/** How a list shows one loan: resource, lender and Space by name, state, reason, and an end date. */
const shown = (grants: ReadonlyArray<Grant>, grantId: string) => {
  const grant = grants.find((candidate) => candidate.id === grantId);
  return grant === undefined
    ? undefined
    : {
        resource: grant.resource.name,
        lender: grant.lender.name,
        target: grant.target?.name ?? null,
        state: grant.state,
        reason: grant.endReason,
        ended: grant.endedAt !== null,
      };
};

/** The open lending link `lender` makes of an AI account; its Grant id. */
const offerAccount = Effect.fn(function* (hub: Hub, lender: UserId, accountId: AiAccountId) {
  yield* hub
    .service(Grants.Grants)
    .createOffer({ resource: { kind: "ai-account", aiAccountId: accountId }, limits: NO_CAP })
    .pipe(CommandActor.actAs(lender), Effect.orDie);
  const [row] = yield* hub.server.sql<{ readonly grantId: GrantId }>`
    SELECT grant_id AS "grantId" FROM grants
    WHERE resource_id = ${accountId} AND state = 'offered' ORDER BY created_at DESC LIMIT 1
  `;
  assert.isDefined(row, "the link's row");
  return row.grantId;
});

/** A named group of Ana's with a Secret, lent to Acme and chosen as one of Acme's defaults. */
const anasGroupLentToAcme = Effect.fn(function* (
  hub: Hub,
  people: Effect.Success<ReturnType<typeof cast>>,
) {
  const vaults = hub.service(Vaults.Vaults);
  const asAna = CommandActor.actAs(people.ana);
  const group = yield* vaults
    .create({ name: "Ana tools", owner: userOwner(people.ana) })
    .pipe(asAna, Effect.orDie);
  yield* vaults
    .putEntry({ vaultId: group.id, name: "ANA_TOKEN", value: Redacted.make("ana-token-1111") })
    .pipe(asAna, Effect.orDie);
  const grantId = yield* lendVaultGroup(hub.server.sql, {
    vaultId: group.id,
    lender: { kind: "user", id: people.ana },
    spaceId: people.acme,
  }).pipe(Effect.orDie);
  yield* hub.server.sql`
    INSERT INTO space_default_vaults (space_id, group_id, position)
    VALUES (${people.acme}, ${group.id}, 9)
  `;
  return { group: group.id as VaultGroupId, grantId };
});

const acmeDefaults = (hub: Hub, acme: SpaceId) =>
  hub.server.sql<{ readonly groupId: string }>`
    SELECT group_id AS "groupId" FROM space_default_vaults WHERE space_id = ${acme}
  `.pipe(Effect.map((rows) => rows.map((row) => row.groupId)));

describe("Hub con Environments: loans end by themselves (Grants 11)", () => {
  it.live(
    "Ana deletes her AI account lent to Acme: the loan ends resource-gone, her link is cancelled, Acme reaches it no more, and both sides still see it by name",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const people = yield* cast(hub);
        const account = yield* addAccount(hub, people.ana, "Ana Claude");
        const grantId = yield* lendAiAccount(hub.server.sql, {
          accountId: account,
          lender: { kind: "user", id: people.ana },
          spaceId: people.acme,
        }).pipe(Effect.orDie);
        const link = yield* offerAccount(hub, people.ana, account);
        assert.include(yield* reachedAccounts(hub, people.mia, people.acme), account);

        // Deleted: its key may still be live in the gateway for a moment; the loan is not.
        yield* hub
          .service(AiAccounts.AiAccounts)
          .remove({ accountId: account })
          .pipe(CommandActor.actAs(people.ana), Effect.exit);

        assert.deepEqual(yield* stateOf(hub, grantId), ["ended", "resource-gone"]);
        assert.deepEqual(yield* stateOf(hub, link), ["cancelled", null]);
        assert.notInclude(yield* reachedAccounts(hub, people.mia, people.acme), account);
        assert.deepEqual(yield* auditsOf(hub, grantId), [
          ["grant.end", "resource-gone", "system", "ai_account.delete"],
        ]);
        assert.deepEqual(yield* auditsOf(hub, link), [
          ["grant.cancel", null, null, "ai_account.delete"],
        ]);
        // Once the gateway let the key go its row goes too; the loan keeps its name.
        assert.isTrue(
          yield* eventually(
            hub.server.sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM ai_accounts WHERE account_id = ${account}
            `.pipe(Effect.map((rows) => rows[0]?.n === 0)),
          ),
          "the account's row went",
        );
        const expected: ReturnType<typeof shown> = {
          resource: "Ana Claude",
          lender: "Ana",
          target: "Acme",
          state: "ended",
          reason: "resource-gone",
          ended: true,
        };
        assert.deepEqual(shown(yield* given(hub, people.ana), grantId), expected);
        assert.deepEqual(shown(yield* received(hub, people.mia, people.acme), grantId), expected);
      }).pipe(Effect.scoped),
  );

  it.live(
    "Ana deletes her Vault group lent to Acme: the loan ends resource-gone, Acme's default of it goes audited, and Acme no longer sees it",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const people = yield* cast(hub);
        const { group, grantId } = yield* anasGroupLentToAcme(hub, people);
        assert.include(yield* borrowedGroups(hub, people.mia), group);

        yield* hub
          .service(Vaults.Vaults)
          .remove({ vaultId: group })
          .pipe(CommandActor.actAs(people.ana), Effect.orDie);

        assert.deepEqual(yield* stateOf(hub, grantId), ["ended", "resource-gone"]);
        assert.notInclude(yield* borrowedGroups(hub, people.mia), group);
        assert.deepEqual(yield* acmeDefaults(hub, people.acme), []);
        assert.deepEqual(yield* auditsOf(hub, grantId), [
          ["grant.end", "resource-gone", "system", "vault_group.delete"],
        ]);
        // Acme's default of it went as at «Return»: audited under Acme.
        const dropped = yield* hub.server.sql<{ readonly space: string }>`
          SELECT space_id AS space FROM audit_log
          WHERE action = 'vault.choose' AND target_id = ${group}
            AND json_extract(detail_json, '$.via') = 'grant.end'
        `;
        assert.deepEqual(
          dropped.map((row) => row.space),
          [people.acme],
        );
        assert.deepEqual(shown(yield* received(hub, people.mia, people.acme), grantId), {
          resource: "Ana tools",
          lender: "Ana",
          target: "Acme",
          state: "ended",
          reason: "resource-gone",
          ended: true,
        });
      }).pipe(Effect.scoped),
  );

  it.live("a machine removed or dedicated to an Organization cancels its open lending links", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ aiAccounts: true });
      const people = yield* cast(hub);
      const at = "2026-11-20T00:00:00.000Z";
      yield* hub.server.sql`
        INSERT INTO environments (environment_id, name, kind, mode, owner_user_id, space_id,
          credential_hash, credential_issued_at, registered_at)
        VALUES ('ana-box', 'Ana box', 'external', 'personal', ${people.ana}, NULL, 'hash-ana-box',
          ${at}, ${at})
      `;
      yield* hub.server.sql`
        INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
          target_kind, target_id, state, limits_json, created_at, offer_token_hash,
          offer_expires_at)
        VALUES ('grant-box-link', 'environment', 'ana-box', 'user', ${people.ana}, 'space', NULL,
          'offered', '{"kind":"environment","cpus":1,"memoryBytes":1073741824,"pids":256,"diskBytes":1073741824}',
          ${at}, 'hash-of-a-token', '2099-01-01T00:00:00.000Z')
      `;
      yield* hub
        .service(EnvironmentRegistry.EnvironmentRegistry)
        .remove({ actorUserId: people.ana, environmentId: "ana-box" as never })
        .pipe(Effect.orDie);
      assert.deepEqual(yield* stateOf(hub, "grant-box-link"), ["cancelled", null]);
      assert.deepEqual(yield* auditsOf(hub, "grant-box-link"), [
        ["grant.cancel", null, null, "environment.remove"],
      ]);

      // The Owner dedicates their machine to Acme: no longer theirs to lend, so their link dies.
      yield* hub.server.sql`
        INSERT INTO environments (environment_id, name, kind, mode, owner_user_id, space_id,
          credential_hash, credential_issued_at, registered_at)
        VALUES ('owner-box', 'Owner box', 'external', 'personal', ${people.owner}, NULL,
          'hash-owner-box', ${at}, ${at})
      `;
      yield* hub.server.sql`
        INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
          target_kind, target_id, state, limits_json, created_at, offer_token_hash,
          offer_expires_at)
        VALUES ('grant-owner-link', 'environment', 'owner-box', 'user', ${people.owner}, 'space',
          NULL, 'offered',
          '{"kind":"environment","cpus":1,"memoryBytes":1073741824,"pids":256,"diskBytes":1073741824}',
          ${at}, 'hash-of-another-token', '2099-01-01T00:00:00.000Z')
      `;
      yield* hub
        .service(EnvironmentRegistry.EnvironmentRegistry)
        .changeMode({
          actorUserId: people.owner,
          environmentId: "owner-box" as never,
          mode: "dedicated",
          spaceId: people.acme,
        })
        .pipe(Effect.orDie);
      assert.deepEqual(yield* stateOf(hub, "grant-owner-link"), ["cancelled", null]);
      assert.deepEqual(yield* auditsOf(hub, "grant-owner-link"), [
        ["grant.cancel", null, null, "environment.mode.change"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "Globex deleted: its AI account's loan to Acme ends lender-gone, and Acme still sees whose it was",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const people = yield* cast(hub);
        const account = yield* addAccount(hub, people.owner, "Globex Claude", {
          kind: "organization",
          spaceId: people.globex,
        });
        const grantId = yield* lendAiAccount(hub.server.sql, {
          accountId: account,
          lender: { kind: "organization", id: people.globex },
          spaceId: people.acme,
        }).pipe(Effect.orDie);
        assert.include(yield* reachedAccounts(hub, people.mia, people.acme), account);
        const organizations = hub.service(OrganizationLifecycle.OrganizationLifecycle);
        yield* organizations.archive(people.owner, people.globex).pipe(Effect.orDie);
        yield* organizations.delete(people.owner, people.globex).pipe(Effect.orDie);

        assert.deepEqual(yield* stateOf(hub, grantId), ["ended", "lender-gone"]);
        assert.notInclude(yield* reachedAccounts(hub, people.mia, people.acme), account);
        assert.deepEqual(yield* auditsOf(hub, grantId), [
          ["grant.end", "lender-gone", "system", "organization.delete"],
        ]);
        assert.deepEqual(shown(yield* received(hub, people.mia, people.acme), grantId), {
          resource: "Globex Claude",
          lender: "Globex",
          target: "Acme",
          state: "ended",
          reason: "lender-gone",
          ended: true,
        });
      }).pipe(Effect.scoped),
  );

  it.live(
    "Acme deleted: Ana's loan to it ends target-gone, and Ana still sees it, with Acme's name",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const people = yield* cast(hub);
        const account = yield* addAccount(hub, people.ana, "Ana Claude");
        const grantId = yield* lendAiAccount(hub.server.sql, {
          accountId: account,
          lender: { kind: "user", id: people.ana },
          spaceId: people.acme,
        }).pipe(Effect.orDie);
        const organizations = hub.service(OrganizationLifecycle.OrganizationLifecycle);
        yield* organizations.archive(people.owner, people.acme).pipe(Effect.orDie);
        yield* organizations.delete(people.owner, people.acme).pipe(Effect.orDie);

        assert.deepEqual(yield* stateOf(hub, grantId), ["ended", "target-gone"]);
        assert.deepEqual(yield* auditsOf(hub, grantId), [
          ["grant.end", "target-gone", "system", "organization.delete"],
        ]);
        assert.deepEqual(shown(yield* given(hub, people.ana), grantId), {
          resource: "Ana Claude",
          lender: "Ana",
          target: "Acme",
          state: "ended",
          reason: "target-gone",
          ended: true,
        });
      }).pipe(Effect.scoped),
  );

  it.live(
    "Ana removed: her group's loan to Acme ends lender-gone before her Vault goes; Acme's default of it goes audited, and Acme still sees it by name",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const people = yield* cast(hub);
        const { group, grantId } = yield* anasGroupLentToAcme(hub, people);
        yield* hub
          .service(InstallationUserService.InstallationUserService)
          .setStatus({ actorUserId: people.owner, userId: people.ana, status: "removed" })
          .pipe(Effect.orDie);

        assert.deepEqual(yield* stateOf(hub, grantId), ["ended", "lender-gone"]);
        assert.notInclude(yield* borrowedGroups(hub, people.mia), group);
        assert.deepEqual(yield* auditsOf(hub, grantId), [
          ["grant.end", "lender-gone", "system", "user.remove"],
        ]);
        const dropped = yield* hub.server.sql<{ readonly space: string }>`
          SELECT space_id AS space FROM audit_log
          WHERE action = 'vault.choose' AND target_id = ${group}
            AND json_extract(detail_json, '$.via') = 'grant.end'
        `;
        assert.deepEqual(
          dropped.map((row) => row.space),
          [people.acme],
        );
        assert.deepEqual(shown(yield* received(hub, people.adam, people.acme), grantId), {
          resource: "Ana tools",
          lender: "Ana",
          target: "Acme",
          state: "ended",
          reason: "lender-gone",
          ended: true,
        });
      }).pipe(Effect.scoped),
  );

  it.live(
    "neither Ana leaving Acme nor Acme being archived ends her loan; restored, Acme uses it again",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ aiAccounts: true });
        const people = yield* cast(hub);
        const account = yield* addAccount(hub, people.ana, "Ana Claude");
        const grantId = yield* lendAiAccount(hub.server.sql, {
          accountId: account,
          lender: { kind: "user", id: people.ana },
          spaceId: people.acme,
        }).pipe(Effect.orDie);
        const { group, grantId: groupGrant } = yield* anasGroupLentToAcme(hub, people);

        yield* hub
          .service(MembershipService.MembershipService)
          .leave(people.ana, people.acme)
          .pipe(Effect.orDie);
        assert.deepEqual(yield* stateOf(hub, grantId), ["active", null]);
        assert.deepEqual(yield* stateOf(hub, groupGrant), ["active", null]);
        assert.include(yield* reachedAccounts(hub, people.mia, people.acme), account);
        assert.include(yield* borrowedGroups(hub, people.mia), group);
        // She still takes it back; Acme still gives it back.
        const listed = yield* given(hub, people.ana);
        assert.isTrue(listed.find((grant) => grant.id === grantId)?.can.revoke);

        const organizations = hub.service(OrganizationLifecycle.OrganizationLifecycle);
        yield* organizations.archive(people.owner, people.acme).pipe(Effect.orDie);
        assert.deepEqual(yield* stateOf(hub, grantId), ["active", null]);
        assert.deepEqual(yield* stateOf(hub, groupGrant), ["active", null]);
        assert.deepEqual(yield* reachedAccounts(hub, people.mia, people.acme), []);
        yield* organizations.restore(people.owner, people.acme).pipe(Effect.orDie);
        assert.include(yield* reachedAccounts(hub, people.mia, people.acme), account);
        assert.include(yield* borrowedGroups(hub, people.mia), group);
        assert.deepEqual(yield* auditsOf(hub, grantId), []);
      }).pipe(Effect.scoped),
  );
});

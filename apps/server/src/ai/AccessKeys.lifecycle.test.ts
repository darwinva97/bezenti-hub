// @effect-diagnostics globalJsonInEffect:off - reads the audit's JSON detail.
/**
 * Access-keys ticket 07: an access key follows its Space. Deleting an Organization or removing the
 * User of a Personal space revokes its keys in the same transaction; archiving or disabling only
 * refuses them; whoever issued a key leaving changes nothing; an account the Space no longer has
 * stops counting. On a real port over the fake CLIProxyAPI, through the Hub's own HTTP doors.
 */
import { assert, it } from "@effect/vitest";
import { type AiAccountId, SpaceId, type UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import {
  call,
  type Hub,
  hub,
  messages,
  platform,
  posix,
  upstreamModels,
} from "./AiGatewayRoute.testkit.ts";

const MESSAGES = "/api/ai/anthropic/v1/messages";
const WEEK = { days: 7 } as const;
const personalOf = (userId: UserId) => SpaceId.make(`personal:${userId}`);

/** An AI account of its owner: Acme's (added by Ada), or the actor's own. */
const claudeOf = (setup: Hub, as: UserId, name: string, organization = true) =>
  setup.accounts
    .create({
      name,
      provider: "claude",
      apiKey: Redacted.make(`sk-${name.replaceAll(" ", "-").toLowerCase()}-0123456789abcdef`),
      ...(organization ? { owner: { kind: "organization", spaceId: setup.acmeId } as const } : {}),
    })
    .pipe(
      CommandActor.actAs(as),
      Effect.map((made): AiAccountId => made.id),
    );

const keyIn = (setup: Hub, as: UserId, spaceId: SpaceId, label = "Partner") =>
  setup.accessKeys
    .createForSession({ spaceId, label, validity: WEEK, models: ["*"], unlimited: true })
    .pipe(CommandActor.actAs(as));

const ask = (setup: Hub, made: { readonly key: Redacted.Redacted<string> }) =>
  call(setup, MESSAGES, { key: Redacted.value(made.key), body: messages() });

const reasonOf = (setup: Hub, keyId: string) =>
  setup.server.sql<{ readonly reason: string | null }>`
    SELECT revoked_reason AS reason FROM ai_access_keys WHERE key_id = ${keyId}
  `.pipe(Effect.map((rows) => rows[0]?.reason ?? null));

const hubRevocations = (setup: Hub) =>
  setup.server.sql<{
    readonly source: string;
    readonly user: string | null;
    readonly detail: string;
  }>`
    SELECT actor_source AS source, actor_user_id AS user, detail_json AS detail FROM audit_log
    WHERE action = 'access_key.revoke' ORDER BY rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> })),
    ),
  );

it.live.skipIf(!posix || platform === undefined)(
  "deleting an Organization revokes its keys in the same transaction; a deletion that fails revokes nothing",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* claudeOf(setup, setup.people.admin, "Acme Claude");
      const made = yield* keyIn(setup, setup.people.admin, setup.acmeId);
      assert.equal((yield* ask(setup, made)).status, 200);
      const archived = yield* setup.server.request(`/api/spaces/${setup.acmeId}/archive`, {
        body: {},
        cookie: setup.ownerCookie,
      });
      assert.equal(archived.status, 200);
      // Archived: refused, not revoked; the Owner's list says so.
      assert.equal((yield* ask(setup, made)).status, 403);
      assert.isNull(yield* reasonOf(setup, made.created.keyId));
      const everyone = yield* setup.accessKeys.listForSession({}).pipe(setup.asOwner);
      assert.deepEqual(
        everyone.keys.map((key) => [key.label, key.spaceState]),
        [["Partner", "archived"]],
      );

      // A deletion whose transaction fails after the keys were revoked (its own AI accounts
      // cannot be retired) takes nothing with it.
      yield* setup.server.sql`
        CREATE TRIGGER test_accounts_unretirable BEFORE UPDATE ON ai_accounts
        BEGIN SELECT RAISE(ABORT, 'refused by the test'); END
      `;
      const failed = yield* setup.server.request(`/api/spaces/${setup.acmeId}/delete`, {
        body: {},
        cookie: setup.ownerCookie,
      });
      assert.notEqual(failed.status, 200);
      assert.isNull(yield* reasonOf(setup, made.created.keyId));
      assert.lengthOf(yield* hubRevocations(setup), 0);
      yield* setup.server.sql`DROP TRIGGER test_accounts_unretirable`;

      const deleted = yield* setup.server.request(`/api/spaces/${setup.acmeId}/delete`, {
        body: {},
        cookie: setup.ownerCookie,
      });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      assert.equal(yield* reasonOf(setup, made.created.keyId), "space-gone");
      assert.deepEqual(yield* hubRevocations(setup), [
        {
          source: "system",
          user: null,
          detail: { space: setup.acmeId, reason: "space-gone", via: "organization.delete" },
        },
      ]);
      assert.equal((yield* ask(setup, made)).status, 401);
      const gone = yield* setup.accessKeys
        .listForSession({ includeEnded: true })
        .pipe(setup.asOwner);
      assert.deepEqual(
        gone.keys.map((key) => key.spaceState),
        ["gone"],
      );
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "disabling the User of a Personal space refuses its keys and enabling brings them back; removing them revokes the keys",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const grace = setup.people.member;
      yield* claudeOf(setup, grace, "Grace Claude", false);
      const made = yield* keyIn(setup, grace, personalOf(grace), "A friend");
      const status = (value: string) =>
        setup.server.request(`/api/installation/users/${grace}/status`, {
          body: { status: value },
          cookie: setup.ownerCookie,
        });
      assert.equal((yield* ask(setup, made)).status, 200);
      assert.equal((yield* status("disabled")).status, 200);
      const refused = yield* ask(setup, made);
      assert.equal(refused.status, 403);
      assert.include(refused.text, "not available while its User is disabled");
      assert.isNull(yield* reasonOf(setup, made.created.keyId));
      assert.equal((yield* status("active")).status, 200);
      assert.equal((yield* ask(setup, made)).status, 200);

      assert.equal((yield* status("disabled")).status, 200);
      const removed = yield* status("removed");
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(yield* reasonOf(setup, made.created.keyId), "space-gone");
      const [revocation] = yield* hubRevocations(setup);
      assert.deepEqual(revocation?.detail, {
        space: personalOf(grace),
        reason: "space-gone",
        via: "user.remove",
      });
      assert.equal(revocation?.source, "system");
      assert.equal((yield* ask(setup, made)).status, 401);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "the Admin who issued a key leaving Acme changes nothing: it answers, and another Admin sees and revokes it",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ada = setup.people.admin;
      yield* claudeOf(setup, ada, "Acme Claude");
      yield* addMember(setup.server, { id: "olga", displayName: "olga" });
      yield* joinOrganization(setup.server, setup.acmeId, "olga", "admin");
      yield* setup.server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key,
          sign_count, transports, rp_id, created_at)
        VALUES ('olga-key', 'olga', 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
      const olga = "olga" as UserId;
      yield* setup.directory.membershipsChanged([olga]);
      const made = yield* keyIn(setup, ada, setup.acmeId);

      yield* setup.server.sql`
        DELETE FROM space_memberships WHERE space_id = ${setup.acmeId} AND user_id = ${ada}
      `;
      yield* setup.directory.membershipsChanged([ada]);
      assert.equal((yield* ask(setup, made)).status, 200);
      // Ada no longer sees it; Olga does, issued by Ada, and revokes it.
      const adas = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(ada), Effect.flip);
      assert.equal(adas.reason, "forbidden");
      const olgas = yield* setup.accessKeys
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(olga));
      assert.deepEqual(
        olgas.keys.map((key) => [key.keyId, key.createdBy]),
        [[made.created.keyId, ada]],
      );
      yield* setup.accessKeys
        .revokeForSession({ keyId: made.created.keyId })
        .pipe(CommandActor.actAs(olga));
      assert.equal((yield* ask(setup, made)).status, 401);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "an account deleted or given to another owner stops counting from the next request; with none left, 403",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const a = yield* claudeOf(setup, setup.people.admin, "Acme Claude A");
      const b = yield* claudeOf(setup, setup.people.admin, "Acme Claude B");
      const made = yield* keyIn(setup, setup.people.admin, setup.acmeId);
      assert.equal((yield* ask(setup, made)).status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${a}/claude-sonnet-5-5`);
      // A deleted (as the account's removal records it): B serves.
      yield* setup.server.sql`
        UPDATE ai_accounts SET deleted_at = '2026-11-20T00:00:00.000Z' WHERE account_id = ${a}
      `;
      assert.equal((yield* ask(setup, made)).status, 200);
      assert.equal(upstreamModels(setup).at(-1), `acct-${b}/claude-sonnet-5-5`);
      // B given to Ada herself: no longer Acme's, so none is left.
      yield* setup.server.sql`
        UPDATE ai_accounts SET owner_kind = 'user', owner_id = ${setup.people.admin}
        WHERE account_id = ${b}
      `;
      const none = yield* ask(setup, made);
      assert.equal(none.status, 403);
      assert.include(none.text, "No AI account this access key may use is available now.");
    }).pipe(Effect.scoped),
);

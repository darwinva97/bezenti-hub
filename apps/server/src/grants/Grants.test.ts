/**
 * Grants ticket 01 (machines): lending a personal machine to a Space, deciding on it and ending
 * it, by the people the policy names, with a strong factor whenever a machine's loan becomes active.
 */
import { GrantId, type GrantState, SpaceId, UserId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  passkeyReauth,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as Grants from "./Grants.ts";

const GIVE = "/api/grants/give";
const ACCEPT = "/api/grants/accept";
const at = "2026-11-16T00:00:00.000Z";
const LIMITS = {
  kind: "environment",
  cpus: 2,
  memoryBytes: 2 * 1024 ** 3,
  pids: 512,
  diskBytes: 10 * 1024 ** 3,
} as const;
/** A proof no one could pass: a refusal must come before it is checked, or because of it. */
const BOGUS_REAUTH = { method: "password", password: "nope", totpCode: "000000" };

const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: owner,
    });
    return SpaceId.make(made.body.id as string);
  });
  const acmeId = yield* organization("Acme");
  const globexId = yield* organization("Globex");
  // The Owner runs Acme as one of its Admins; Ana works there, Adam runs it too, Linus is a
  // Guest. Grecia shares no Space with anyone.
  yield* server.sql`
    INSERT OR IGNORE INTO space_memberships (space_id, user_id, role, created_at)
    VALUES (${acmeId}, ${ownerId}, 'admin', ${at})
  `;
  const person = Effect.fn(function* (id: string, role?: "admin" | "member" | "guest") {
    const cookie = yield* addMember(server, { id, displayName: id });
    if (role !== undefined) yield* joinOrganization(server, acmeId, id, role);
    return { id: UserId.make(id), cookie };
  });
  const ana = yield* person("ana", "member");
  const adam = yield* person("adam", "admin");
  const linus = yield* person("linus", "guest");
  const grecia = yield* person("grecia");
  const machine = Effect.fn(function* (
    id: string,
    ownerUserId: string | null,
    options: { readonly kind?: string; readonly mode?: string; readonly spaceId?: string } = {},
  ) {
    yield* server.sql`
      INSERT INTO environments (
        environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
        credential_issued_at, registered_at
      ) VALUES (${id}, ${`${id} box`}, ${options.kind ?? "external"},
        ${options.mode ?? "personal"}, ${ownerUserId}, ${options.spaceId ?? null},
        ${`hash-${id}`}, ${at}, ${at})
    `;
    return id;
  });
  const grants = Context.get(server.services, Grants.Grants);
  const give = (cookie: string, environmentId: string, spaceId: string, reauth?: unknown) =>
    server.request(GIVE, {
      cookie,
      body: {
        resource: { kind: "environment", environmentId },
        spaceId,
        limits: LIMITS,
        ...(reauth === undefined ? {} : { reauth }),
      },
    });
  const accept = (cookie: string, grantId: string, reauth?: unknown) =>
    server.request(ACCEPT, {
      cookie,
      body: { grantId, ...(reauth === undefined ? {} : { reauth }) },
    });
  const stateOf = (grantId: string) =>
    server.sql<{ readonly state: GrantState; readonly endReason: string | null }>`
      SELECT state, end_reason AS "endReason" FROM grants WHERE grant_id = ${grantId}
    `.pipe(Effect.map((rows) => rows[0]));
  const audited = (grantId: string) =>
    server.sql<{ readonly action: string }>`
      SELECT action FROM audit_log WHERE target_kind = 'grant' AND target_id = ${grantId}
      ORDER BY rowid
    `.pipe(Effect.map((rows) => rows.map((row) => row.action)));
  return {
    server,
    authenticator,
    owner,
    ownerId,
    acmeId,
    globexId,
    ana,
    adam,
    linus,
    grecia,
    machine,
    grants,
    give,
    accept,
    stateOf,
    audited,
  };
});

describe("Grants", () => {
  it("allows each change only from the states the table names", () => {
    const states: ReadonlyArray<GrantState> = [
      "offered",
      "pending",
      "active",
      "rejected",
      "cancelled",
      "ended",
    ];
    const allowed = (op: Grants.GrantOp) =>
      states.filter((state) => Grants.mayTransition(op, state));
    assert.deepEqual(allowed("accept"), ["pending"]);
    assert.deepEqual(allowed("reject"), ["pending"]);
    assert.deepEqual(allowed("cancel"), ["offered", "pending"]);
    assert.deepEqual(allowed("end"), ["active"]);
    assert.deepEqual(allowed("setLimits"), ["pending", "active"]);
  });

  it.effect(
    "a machine's loan waits for the destination, which accepts it with a strong factor",
    () =>
      Effect.gen(function* () {
        const h = yield* hub;
        const vps = yield* h.machine("ana-vps", h.ana.id);
        const ownersPersonal = `personal:${h.ownerId}`;
        const given = yield* h.give(h.ana.cookie, vps, ownersPersonal);
        assert.equal(given.status, 200, JSON.stringify(given.body));
        assert.equal(given.body.state, "pending");
        const grantId = given.body.id as string;

        // Without a proof, or with a wrong one, nothing changes.
        assert.equal((yield* h.accept(h.owner, grantId)).status, 403);
        assert.equal((yield* h.accept(h.owner, grantId, BOGUS_REAUTH)).status, 403);
        assert.equal((yield* h.stateOf(grantId))?.state, "pending");
        // Nor over the service without one (the WS side has no factor to give).
        const unproven = yield* h.grants
          .accept({ grantId: GrantId.make(grantId) }, { strongFactor: false })
          .pipe(CommandActor.actAs(h.ownerId), Effect.flip);
        assert.equal(unproven.reason, "strong-factor-required");

        const accepted = yield* h.accept(
          h.owner,
          grantId,
          yield* passkeyReauth(h.server, h.authenticator),
        );
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        assert.equal(accepted.body.state, "active");
        assert.deepEqual(yield* h.audited(grantId), ["grant.give", "grant.accept"]);
      }),
  );

  it.effect("the Owner lends their machine to anyone's Personal space; it waits for them", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* h.machine("owner-vps", h.ownerId);
      const targets = yield* h.grants
        .targets({ resource: { kind: "environment", environmentId: vps as never } })
        .pipe(CommandActor.actAs(h.ownerId));
      assert.include(
        targets.targets.map((target) => target.spaceId),
        `personal:${h.grecia.id}`,
      );
      const given = yield* h.give(h.owner, vps, `personal:${h.grecia.id}`);
      assert.equal(given.status, 200, JSON.stringify(given.body));
      assert.equal(given.body.state, "pending");
      const grantId = given.body.id as string;
      const received = yield* h.grants.listReceived({}).pipe(CommandActor.actAs(h.grecia.id));
      assert.deepEqual(
        received.grants.map((grant) => [grant.id, grant.state, grant.can.decide]),
        [[grantId, "pending", true]],
      );
      // Grecia has no strong factor to give: accepting is refused, the loan still waits.
      assert.equal((yield* h.accept(h.grecia.cookie, grantId)).status, 403);
      assert.equal((yield* h.accept(h.grecia.cookie, grantId, BOGUS_REAUTH)).status, 403);
      assert.equal((yield* h.stateOf(grantId))?.state, "pending");
      // She rejects it instead, which needs none.
      const rejected = yield* h.grants
        .reject({ grantId: GrantId.make(grantId) })
        .pipe(CommandActor.actAs(h.grecia.id));
      assert.equal(rejected.state, "rejected");
    }),
  );

  it.effect("a Personal space is named by its owner in the targets and both loan lists", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* h.machine("owner-vps", h.ownerId);
      const targets = yield* h.grants
        .targets({ resource: { kind: "environment", environmentId: vps as never } })
        .pipe(CommandActor.actAs(h.ownerId));
      const byId = new Map(targets.targets.map((target) => [target.spaceId as string, target]));
      // Every Personal space has the same name: only its owner tells them apart.
      assert.equal(
        byId.get(`personal:${h.grecia.id}`)?.name,
        byId.get(`personal:${h.ana.id}`)?.name,
      );
      assert.equal(byId.get(`personal:${h.grecia.id}`)?.ownerDisplayName, "grecia");
      assert.equal(byId.get(`personal:${h.ana.id}`)?.ownerDisplayName, "ana");
      // An Organization has a name of its own and no owner.
      assert.isUndefined(byId.get(h.acmeId)?.ownerDisplayName);

      const given = yield* h.give(h.owner, vps, `personal:${h.grecia.id}`);
      assert.equal(given.status, 200, JSON.stringify(given.body));
      const mine = yield* h.grants.listGiven.pipe(CommandActor.actAs(h.ownerId));
      assert.deepEqual(
        mine.grants.map((grant) => grant.target?.ownerDisplayName),
        ["grecia"],
      );
      const theirs = yield* h.grants.listReceived({}).pipe(CommandActor.actAs(h.grecia.id));
      assert.deepEqual(
        theirs.grants.map((grant) => grant.target?.ownerDisplayName),
        ["grecia"],
      );
    }),
  );

  it.effect("a loan where the lender also decides starts active, with a strong factor", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* h.machine("owner-vps", h.ownerId);
      // The Owner runs Acme: lending there is accepting it too.
      assert.equal((yield* h.give(h.owner, vps, h.acmeId)).status, 403);
      assert.equal((yield* h.give(h.owner, vps, h.acmeId, BOGUS_REAUTH)).status, 403);
      const given = yield* h.give(
        h.owner,
        vps,
        h.acmeId,
        yield* passkeyReauth(h.server, h.authenticator),
      );
      assert.equal(given.status, 200, JSON.stringify(given.body));
      assert.equal(given.body.state, "active");
      // Another live loan of that machine to Acme is refused.
      const again = yield* h.give(
        h.owner,
        vps,
        h.acmeId,
        yield* passkeyReauth(h.server, h.authenticator),
      );
      assert.equal(again.status, 409);
    }),
  );

  it.effect("only a machine's owner lends it, only a personal one, only to Spaces they know", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* h.machine("ana-vps", h.ana.id);
      // Adam runs Acme but the machine is Ana's; Ana is not in Globex.
      assert.equal((yield* h.give(h.adam.cookie, vps, h.acmeId)).status, 403);
      assert.equal((yield* h.give(h.ana.cookie, vps, h.globexId)).status, 403);
      // Grecia shares no Space with Ana: her Personal space is not Ana's to name.
      assert.equal((yield* h.give(h.ana.cookie, vps, `personal:${h.grecia.id}`)).status, 403);
      // A Sandbox or a dedicated machine is not lent.
      const dedicated = yield* h.machine("acme-box", null, {
        mode: "dedicated",
        spaceId: h.acmeId,
      });
      assert.equal((yield* h.give(h.owner, dedicated, h.globexId)).status, 409);
      // Limits below the Sandbox floors are refused.
      const tiny = yield* h.server.request(GIVE, {
        cookie: h.ana.cookie,
        body: {
          resource: { kind: "environment", environmentId: vps },
          spaceId: h.acmeId,
          limits: { ...LIMITS, pids: 8 },
        },
      });
      assert.equal(tiny.status, 409);
      const targets = yield* h.grants
        .targets({ resource: { kind: "environment", environmentId: vps as never } })
        .pipe(CommandActor.actAs(h.ana.id));
      assert.sameMembers(
        targets.targets.map((target) => target.spaceId),
        [h.acmeId, `personal:${h.ownerId}`, `personal:${h.adam.id}`, `personal:${h.linus.id}`],
      );
    }),
  );

  it.effect("either side ends an active loan; nobody else does, and history stays", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* h.machine("ana-vps", h.ana.id);
      const asAna = CommandActor.actAs(h.ana.id);
      // Adam signed in with a password only, so he acts as a Member: the Owner is Acme's Admin.
      const asAcmeAdmin = CommandActor.actAs(h.ownerId);
      const lend = Effect.fn(function* () {
        const given = yield* h.give(h.ana.cookie, vps, h.acmeId);
        assert.equal(given.status, 200, JSON.stringify(given.body));
        const grantId = GrantId.make(given.body.id as string);
        const accepted = yield* h.accept(
          h.owner,
          grantId,
          yield* passkeyReauth(h.server, h.authenticator),
        );
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        return grantId;
      });

      const first = yield* lend();
      // Illegal changes are refused with a typed error.
      assert.equal(
        (yield* h.grants.cancel({ grantId: first }).pipe(asAna, Effect.flip)).reason,
        "illegal-transition",
      );
      // A Member of Acme ends nothing; an outsider does not even see it.
      const member = yield* h.grants
        .end({ grantId: first })
        .pipe(CommandActor.actAs(h.linus.id), Effect.flip);
      assert.equal(member.reason, "not-found");
      const outsider = yield* h.grants
        .end({ grantId: first })
        .pipe(CommandActor.actAs(h.grecia.id), Effect.flip);
      assert.equal(outsider.reason, "not-found");
      const revoked = yield* h.grants.end({ grantId: first }).pipe(asAna);
      assert.deepEqual([revoked.state, revoked.endReason], ["ended", "revoked"]);
      assert.equal(
        (yield* h.grants.end({ grantId: first }).pipe(asAna, Effect.flip)).reason,
        "illegal-transition",
      );

      const second = yield* lend();
      const returned = yield* h.grants.end({ grantId: second }).pipe(asAcmeAdmin);
      assert.deepEqual([returned.state, returned.endReason], ["ended", "returned"]);

      // A waiting one is cancelled by its lender, never ended.
      const third = GrantId.make((yield* h.give(h.ana.cookie, vps, h.acmeId)).body.id as string);
      assert.equal(
        (yield* h.grants.end({ grantId: third }).pipe(asAna, Effect.flip)).reason,
        "illegal-transition",
      );
      assert.equal((yield* h.grants.cancel({ grantId: third }).pipe(asAna)).state, "cancelled");

      const given = yield* h.grants.listGiven.pipe(asAna);
      assert.sameDeepMembers(
        given.grants.map((grant) => [grant.id, grant.state]),
        [
          [first, "ended"],
          [second, "ended"],
          [third, "cancelled"],
        ],
      );
      assert.deepEqual(yield* h.audited(first), ["grant.give", "grant.accept", "grant.end"]);
    }),
  );

  it.effect(
    "a machine that said it cannot host is refused with why; accepting opens its Sandbox",
    () =>
      Effect.gen(function* () {
        const h = yield* hub;
        const vps = yield* h.machine("ana-vps", h.ana.id);
        const report = (ready: boolean) =>
          JSON.stringify({
            ready,
            reason: ready
              ? null
              : "its Sandbox containers could reach this machine's 0.0.0.0:8080.",
            limitSupport: { cpus: false, memory: true, pids: true, note: null },
            reachablePorts: [],
            hostCpus: 4,
            hostMemoryBytes: 8 * 1024 ** 3,
            hostFreeBytes: null,
            hostTotalBytes: null,
          });
        yield* h.server.sql`
        UPDATE environments SET sandbox_host_json = ${report(false)} WHERE environment_id = ${vps}
      `;
        const refused = yield* h.give(h.ana.cookie, vps, `personal:${h.ownerId}`);
        assert.equal(refused.status, 409);
        assert.include(refused.body.message, "0.0.0.0:8080");
        yield* h.server.sql`
        UPDATE environments SET sandbox_host_json = ${report(true)} WHERE environment_id = ${vps}
      `;
        const given = yield* h.give(h.ana.cookie, vps, `personal:${h.ownerId}`);
        assert.equal(given.status, 200, JSON.stringify(given.body));
        type Machine = {
          readonly lentEnvironmentId: string | null;
          readonly host: { readonly limitSupport: { readonly cpus: boolean } };
        };
        // Waiting, it has no Sandbox yet; both sides see what the machine said of itself.
        const waiting = given.body.machine as Machine;
        assert.isNull(waiting.lentEnvironmentId);
        assert.equal(waiting.host.limitSupport.cpus, false);
        const accepted = yield* h.accept(
          h.owner,
          given.body.id as string,
          yield* passkeyReauth(h.server, h.authenticator),
        );
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        assert.equal(
          (accepted.body.machine as Machine).lentEnvironmentId,
          `lent:${given.body.id as string}`,
        );
        const [row] = yield* h.server.sql<{ readonly spaceId: string; readonly host: string }>`
        SELECT space_id AS "spaceId", host_environment_id AS host FROM environments
        WHERE grant_id = ${given.body.id as string} AND mode = 'lent' AND revoked_at IS NULL
      `;
        assert.deepEqual(row, { spaceId: `personal:${h.ownerId}`, host: vps });
      }),
  );

  it.effect("the lender changes limits; nobody else does", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* h.machine("ana-vps", h.ana.id);
      const grantId = GrantId.make((yield* h.give(h.ana.cookie, vps, h.acmeId)).body.id as string);
      const limits = { ...LIMITS, memoryBytes: 1024 ** 3 };
      const changed = yield* h.grants
        .setLimits({ grantId, limits })
        .pipe(CommandActor.actAs(h.ana.id));
      assert.equal(changed.limits.kind === "environment" && changed.limits.memoryBytes, 1024 ** 3);
      // Acme's Admin (the Owner) decides on it but does not set its limits.
      const byAdmin = yield* h.grants
        .setLimits({ grantId, limits })
        .pipe(CommandActor.actAs(h.ownerId), Effect.flip);
      assert.equal(byAdmin.reason, "not-allowed");
      assert.deepEqual(yield* h.audited(grantId), ["grant.give", "grant.limits.change"]);
    }),
  );
});

// Grants ticket 01: an AI account lent for the gateway, by its owner (a User, or an
// Organization's Admins), decided by the destination without a strong factor.
const NO_CAP = { kind: "ai-account", tokens: null, requests: null } as const;

const aiAccount = Effect.fn(function* (
  h: Effect.Success<typeof hub>,
  id: string,
  owner: { readonly kind: "user" | "organization"; readonly id: string },
  type: "api-key" | "subscription" | "direct" = "api-key",
) {
  yield* h.server.sql`
    INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, created_at,
      updated_at, owner_kind, owner_id)
    VALUES (${id}, ${`${id} account`}, ${type}, 'claude', 1, 'ready', ${at}, ${at},
      ${owner.kind}, ${owner.id})
  `;
  return id;
});

const lendAi = (
  h: Effect.Success<typeof hub>,
  cookie: string,
  aiAccountId: string,
  spaceId: string,
  limits: unknown = NO_CAP,
) =>
  h.server.request(GIVE, {
    cookie,
    body: { resource: { kind: "ai-account", aiAccountId }, spaceId, limits },
  });

describe("Grants of AI accounts", () => {
  it.effect(
    "the Owner alone reviews what migrated allowances narrowed; lending or dismissing settles it",
    () =>
      Effect.gen(function* () {
        const h = yield* hub;
        const key = yield* aiAccount(h, "owner-key", { kind: "user", id: h.ownerId });
        // Left by migration 145: Ana used the Owner's account in Acme and in Globex.
        yield* h.server.sql`
          INSERT INTO ai_account_grant_reviews (account_id, user_id, space_id, used_recently,
            created_at)
          VALUES (${key}, ${h.ana.id}, ${h.acmeId}, 1, ${at}),
            (${key}, ${h.ana.id}, ${h.globexId}, 0, ${at})
        `;
        // Nothing reaches Ana in Acme until the Owner acts.
        const live = yield* h.server.sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM grants WHERE resource_id = ${key}
        `;
        assert.equal(live[0]?.n, 0);
        // Nobody but the Owner sees it, not even an Admin.
        for (const who of [h.ana.id, h.adam.id]) {
          const refused = yield* h.grants.migrationReviews.pipe(
            CommandActor.actAs(who),
            Effect.flip,
          );
          assert.equal(refused.reason, "not-allowed");
          const dismissed = yield* h.grants
            .dismissMigrationReview({
              aiAccountId: key as never,
              userId: h.ana.id,
              spaceId: h.acmeId,
            })
            .pipe(CommandActor.actAs(who), Effect.flip);
          assert.equal(dismissed.reason, "not-allowed");
        }
        const asOwner = CommandActor.actAs(h.ownerId);
        const reviews = yield* h.grants.migrationReviews.pipe(asOwner);
        assert.deepEqual(
          reviews.reviews.map((review) => [
            review.spaceName,
            review.userName,
            review.usedRecently,
            review.startsActive,
          ]),
          [
            ["Acme", "ana", true, true],
            ["Globex", "ana", false, false],
          ],
        );
        // Lent to Acme, which the Owner runs: active at once, and the row is settled.
        const lent = yield* lendAi(h, h.owner, key, h.acmeId);
        assert.equal(lent.status, 200, JSON.stringify(lent.body));
        assert.equal(lent.body.state, "active");
        const after = yield* h.grants.migrationReviews.pipe(asOwner);
        assert.deepEqual(
          after.reviews.map((review) => review.spaceName),
          ["Globex"],
        );
        // Dismissed: gone, and nothing lent to Globex.
        const dismissed = yield* h.grants
          .dismissMigrationReview({
            aiAccountId: key as never,
            userId: h.ana.id,
            spaceId: h.globexId,
          })
          .pipe(asOwner);
        assert.deepEqual(dismissed.reviews, []);
        const globex = yield* h.server.sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM grants WHERE resource_id = ${key} AND target_id = ${h.globexId}
        `;
        assert.equal(globex[0]?.n, 0);
      }),
  );

  it.effect("a User lends their AI account to their Organization; an Admin accepts it", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const key = yield* aiAccount(h, "ana-key", { kind: "user", id: h.ana.id });
      const given = yield* lendAi(h, h.ana.cookie, key, h.acmeId);
      assert.equal(given.status, 200, JSON.stringify(given.body));
      assert.equal(given.body.state, "pending");
      const grantId = GrantId.make(given.body.id as string);

      // Ana, a Member, does not see it waiting nor accept it; a Guest neither.
      const anaSees = yield* h.grants.listReceived({}).pipe(CommandActor.actAs(h.ana.id));
      assert.notInclude(
        anaSees.grants.map((grant) => grant.id as string),
        grantId,
      );
      assert.equal((yield* h.accept(h.ana.cookie, grantId)).status, 403);
      const linusSees = yield* h.grants.listReceived({}).pipe(CommandActor.actAs(h.linus.id));
      assert.deepEqual(linusSees.grants, []);

      // Acme's Admin accepts it with no strong factor: it lends an AI account, not a machine.
      const accepted = yield* h.accept(h.owner, grantId);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(accepted.body.state, "active");
      assert.deepEqual(accepted.body.aiAccount, { provider: "claude", type: "api-key" });
      assert.equal((accepted.body.resource as { name: string }).name, "ana-key account");

      // Now Ana, a Member, sees it received; and she sees it given.
      const received = yield* h.grants.listReceived({}).pipe(CommandActor.actAs(h.ana.id));
      assert.deepEqual(
        received.grants.map((grant) => [grant.id, grant.state, grant.can.return]),
        [[grantId, "active", false]],
      );
      const mine = yield* h.grants.listGiven.pipe(CommandActor.actAs(h.ana.id));
      assert.deepEqual(
        mine.grants.map((grant) => [grant.id, grant.can.revoke]),
        [[grantId, true]],
      );

      // The Admin gives it back; illegal changes after that are refused.
      const returned = yield* h.grants.end({ grantId }).pipe(CommandActor.actAs(h.ownerId));
      assert.deepEqual([returned.state, returned.endReason], ["ended", "returned"]);
      for (const change of [
        h.grants.accept({ grantId }, { strongFactor: false }),
        h.grants.reject({ grantId }),
        h.grants.end({ grantId }),
      ]) {
        const refused = yield* change.pipe(CommandActor.actAs(h.ownerId), Effect.flip);
        assert.equal(refused.reason, "illegal-transition");
      }
      const cancelled = yield* h.grants
        .cancel({ grantId })
        .pipe(CommandActor.actAs(h.ana.id), Effect.flip);
      assert.equal(cancelled.reason, "illegal-transition");
      assert.deepEqual(yield* h.audited(grantId), ["grant.give", "grant.accept", "grant.end"]);
    }),
  );

  it.effect("only its owner lends an AI account, never a direct one, never to a Plan", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const key = yield* aiAccount(h, "ana-key", { kind: "user", id: h.ana.id });
      // Not the Owner, not an Admin of the Space it goes to, not to her own Personal space.
      assert.equal((yield* lendAi(h, h.owner, key, `personal:${h.grecia.id}`)).status, 403);
      assert.equal((yield* lendAi(h, h.adam.cookie, key, h.acmeId)).status, 403);
      assert.equal((yield* lendAi(h, h.ana.cookie, key, `personal:${h.ana.id}`)).status, 403);
      // Limits of another kind are refused.
      const machineLimits = yield* lendAi(h, h.ana.cookie, key, h.acmeId, LIMITS);
      assert.equal(machineLimits.status, 409);
      // A direct account never leaves its owner.
      const direct = yield* aiAccount(h, "ana-direct", { kind: "user", id: h.ana.id }, "direct");
      const refusedDirect = yield* lendAi(h, h.ana.cookie, direct, h.acmeId);
      assert.equal(refusedDirect.status, 409);
      assert.include(refusedDirect.body.message as string, "direct");
      // A Plan is not a destination yet.
      const plan = yield* h.grants
        .give(
          {
            resource: { kind: "ai-account", aiAccountId: key as never },
            spaceId: h.acmeId,
            limits: NO_CAP,
            planId: "pro",
          },
          { strongFactor: false },
        )
        .pipe(CommandActor.actAs(h.ana.id), Effect.flip);
      assert.equal(plan.reason, "plan-target-unavailable");
      // Twice to the same Space while one waits: refused.
      assert.equal((yield* lendAi(h, h.ana.cookie, key, h.acmeId)).status, 200);
      assert.equal((yield* lendAi(h, h.ana.cookie, key, h.acmeId)).status, 409);
      // Her targets: where she works and the Personal spaces of those she works with.
      const targets = yield* h.grants
        .targets({ resource: { kind: "ai-account", aiAccountId: key as never } })
        .pipe(CommandActor.actAs(h.ana.id));
      assert.notInclude(
        targets.targets.map((target) => target.spaceId as string),
        `personal:${h.ana.id}`,
      );
      assert.include(
        targets.targets.map((target) => target.spaceId as string),
        h.acmeId,
      );
      assert.isNull(targets.host);
      // Someone else asking for her account's targets is refused.
      const theirs = yield* h.grants
        .targets({ resource: { kind: "ai-account", aiAccountId: key as never } })
        .pipe(CommandActor.actAs(h.linus.id), Effect.flip);
      assert.equal(theirs.reason, "not-allowed");
    }),
  );

  it.effect("an Organization's AI account is lent by its Admins, never by its Members", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const acmes = yield* aiAccount(h, "acme-key", { kind: "organization", id: h.acmeId });
      // Ana, a Member, may not; nor to Acme itself, which owns it.
      assert.equal((yield* lendAi(h, h.ana.cookie, acmes, `personal:${h.ownerId}`)).status, 403);
      assert.equal((yield* lendAi(h, h.owner, acmes, h.acmeId)).status, 403);
      // Acme's Admin lends it to Ana's Personal space; she decides there.
      const given = yield* lendAi(h, h.owner, acmes, `personal:${h.ana.id}`);
      assert.equal(given.status, 200, JSON.stringify(given.body));
      assert.equal(given.body.state, "pending");
      assert.deepEqual(given.body.lender, { kind: "organization", id: h.acmeId, name: "Acme" });
      const grantId = GrantId.make(given.body.id as string);
      // An Admin of Acme sees it given; Ana as Acme's Member does not, only as its receiver.
      const adminGiven = yield* h.grants.listGiven.pipe(CommandActor.actAs(h.ownerId));
      assert.include(
        adminGiven.grants.map((grant) => grant.id as string),
        grantId,
      );
      const anaGiven = yield* h.grants.listGiven.pipe(CommandActor.actAs(h.ana.id));
      assert.deepEqual(anaGiven.grants, []);
      const accepted = yield* h.accept(h.ana.cookie, grantId);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(accepted.body.state, "active");
      // A Member of Acme does not take it back; its Admin does.
      const byMember = yield* h.grants
        .end({ grantId })
        .pipe(CommandActor.actAs(h.linus.id), Effect.flip);
      assert.equal(byMember.reason, "not-found");
      const revoked = yield* h.grants.end({ grantId }).pipe(CommandActor.actAs(h.ownerId));
      assert.deepEqual([revoked.state, revoked.endReason], ["ended", "revoked"]);
    }),
  );
});

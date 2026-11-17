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
      assert.equal(changed.limits.memoryBytes, 1024 ** 3);
      // Acme's Admin (the Owner) decides on it but does not set its limits.
      const byAdmin = yield* h.grants
        .setLimits({ grantId, limits })
        .pipe(CommandActor.actAs(h.ownerId), Effect.flip);
      assert.equal(byAdmin.reason, "not-allowed");
      assert.deepEqual(yield* h.audited(grantId), ["grant.give", "grant.limits.change"]);
    }),
  );
});

// @effect-diagnostics globalJsonInEffect:off - reads the audit rows as they are stored.
/**
 * Makita ticket 02: the Owner gives and takes back «may use Makita» per User and Space; nobody
 * else lists or changes it; a row takes effect only while its User is still there.
 */
import { assert, it } from "@effect/vitest";
import { SpaceId, type UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import { makitaHub, type MakitaHub } from "./Makita.testkit.ts";

const personalOf = (userId: UserId) => SpaceId.make(`personal:${userId}`);

/** `makita.use` for this User in this Space, as the Hub's data stands now. */
const makitaUse = (setup: MakitaHub, userId: UserId, spaceId: SpaceId) =>
  Effect.gen(function* () {
    const principal = yield* setup.directory.principalOf(userId);
    const space = (yield* setup.directory.spacesById([spaceId])).get(spaceId)!;
    const rows = yield* setup.server.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM makita_permissions
      WHERE user_id = ${userId} AND space_id = ${spaceId}
    `;
    const decision = AccessPolicy.decide(principal, "makita.use", {
      kind: "makita-space",
      space: space.resource,
      permitted: (rows[0]?.n ?? 0) > 0,
    });
    return decision._tag === "Allow" ? "allow" : decision.reason;
  });

const grant = (setup: MakitaHub, userId: UserId, spaceId: SpaceId) =>
  setup.makitaPermissions.grantForSession({ userId, spaceId }).pipe(setup.asOwner);

const auditOf = (setup: MakitaHub, action: string) =>
  setup.server.sql<{ readonly target: string; readonly detail: string }>`
    SELECT target_id AS target, detail_json AS detail FROM audit_log WHERE action = ${action}
    ORDER BY audit_id
  `;

it.live.skipIf(!posix || platform === undefined)(
  "the Owner gives it to an Admin or Member of an Organization and to a User in their own Personal space, never to a Guest, the Owner, or elsewhere",
  () =>
    Effect.gen(function* () {
      const setup = yield* makitaHub;
      const { admin, member, guest, globexMember } = setup.people;
      const before = yield* setup.makitaPermissions.listForSession.pipe(setup.asOwner);
      assert.deepEqual(before.permissions, []);
      // The candidates: Ada and Grace in Acme, Gus in Globex, each in their Personal space.
      const grace = before.candidates.find((candidate) => candidate.userId === member)!;
      assert.sameMembers(
        grace.spaces.map((space) => space.spaceId),
        [setup.acmeId, personalOf(member)],
      );
      const linus = before.candidates.find((candidate) => candidate.userId === guest)!;
      assert.deepEqual(
        linus.spaces.map((space) => space.spaceId),
        [personalOf(guest)],
      );
      assert.isUndefined(before.candidates.find((candidate) => candidate.userId === setup.ownerId));

      yield* grant(setup, member, setup.acmeId);
      yield* grant(setup, admin, setup.acmeId);
      yield* grant(setup, globexMember, personalOf(globexMember));
      // Granting again changes nothing and audits nothing.
      const listed = yield* grant(setup, member, setup.acmeId);
      assert.deepEqual(
        listed.permissions
          .map((row): ReadonlyArray<string | null> => [
            row.userId,
            row.spaceId,
            row.role,
            row.state,
            row.grantedBy,
          ])
          .toSorted(),
        [
          [admin, setup.acmeId, "admin", "ok", setup.ownerId],
          [globexMember, personalOf(globexMember), "personal", "ok", setup.ownerId],
          [member, setup.acmeId, "member", "ok", setup.ownerId],
        ].toSorted(),
      );
      // A granted pair is no longer a candidate.
      assert.notInclude(
        listed.candidates
          .find((candidate) => candidate.userId === member)!
          .spaces.map((space) => space.spaceId),
        setup.acmeId,
      );

      for (const [userId, spaceId] of [
        [guest, setup.acmeId],
        [setup.ownerId, setup.acmeId],
        [globexMember, setup.acmeId],
        [member, personalOf(globexMember)],
        [member, SpaceId.make("org-nowhere")],
      ] as const) {
        const refused = yield* grant(setup, userId, spaceId).pipe(Effect.flip);
        assert.equal(refused.reason, "invalid", `${userId} in ${spaceId}`);
      }
      const audit = yield* auditOf(setup, "makita.permission.grant");
      assert.deepEqual(
        audit.map((row) => [row.target, JSON.parse(row.detail)]),
        [
          [member, { space: setup.acmeId, role: "member" }],
          [admin, { space: setup.acmeId, role: "admin" }],
          [globexMember, { space: personalOf(globexMember), role: "personal" }],
        ],
      );

      // A row in Acme says nothing of Globex; Linus never has it; the Owner needs none.
      assert.equal(yield* makitaUse(setup, member, setup.acmeId), "allow");
      assert.equal(yield* makitaUse(setup, member, setup.globexId), "not-a-member");
      assert.equal(yield* makitaUse(setup, guest, setup.acmeId), "role-not-allowed");
      assert.equal(yield* makitaUse(setup, admin, personalOf(admin)), "makita-not-permitted");
      assert.equal(yield* makitaUse(setup, setup.ownerId, setup.globexId), "allow");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "only the Owner's own session lists, gives or takes it back: not an Admin, a Member, an agent, the shell or a one-Space session",
  () =>
    Effect.gen(function* () {
      const setup = yield* makitaHub;
      const { admin, member } = setup.people;
      yield* grant(setup, member, setup.acmeId);
      const actors = [
        CommandActor.actAs(admin),
        CommandActor.actAs(member),
        CommandActor.actAs(setup.people.guest),
        CommandActor.actAsResolved({ _tag: "User", userId: setup.ownerId, via: "agent" }),
        CommandActor.actAsResolved({
          _tag: "User",
          userId: setup.ownerId,
          spaceLimit: setup.acmeId,
        }),
        CommandActor.actAsResolved({ _tag: "Server", via: "cli" }),
      ];
      for (const [index, as] of actors.entries()) {
        for (const attempt of [
          setup.makitaPermissions.listForSession,
          // An Admin giving it to themselves, or taking Grace's away.
          setup.makitaPermissions.grantForSession({ userId: admin, spaceId: setup.acmeId }),
          setup.makitaPermissions.revokeForSession({ userId: member, spaceId: setup.acmeId }),
        ]) {
          const refused = yield* attempt.pipe(as, Effect.flip);
          assert.equal(refused.reason, "forbidden", `actor ${index}`);
        }
      }
      const listed = yield* setup.makitaPermissions.listForSession.pipe(setup.asOwner);
      assert.deepEqual(
        listed.permissions.map((row) => row.userId),
        [member],
      );
      assert.equal(yield* makitaUse(setup, admin, setup.acmeId), "makita-not-permitted");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a row takes no effect once its User leaves the Space, and comes back with them; revoking is audited and idempotent; removing the User from the Hub drops their rows",
  () =>
    Effect.gen(function* () {
      const setup = yield* makitaHub;
      const { member } = setup.people;
      yield* grant(setup, member, setup.acmeId);
      yield* grant(setup, member, personalOf(member));

      // Grace leaves Acme (the Owner removes her): the row stays, without effect.
      const removed = yield* setup.server.request(`/api/spaces/${setup.acmeId}/members/remove`, {
        body: { userId: member },
        cookie: setup.ownerCookie,
      });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      yield* setup.directory.membershipsChanged([member]);
      assert.equal(yield* makitaUse(setup, member, setup.acmeId), "not-a-member");
      const after = yield* setup.makitaPermissions.listForSession.pipe(setup.asOwner);
      const acme = after.permissions.find((row) => row.spaceId === setup.acmeId)!;
      assert.deepEqual([acme.role, acme.state], [null, "not-a-member"]);

      // Revoked by the Owner: once audited, a second time nothing.
      yield* setup.makitaPermissions
        .revokeForSession({ userId: member, spaceId: setup.acmeId })
        .pipe(setup.asOwner);
      yield* setup.makitaPermissions
        .revokeForSession({ userId: member, spaceId: setup.acmeId })
        .pipe(setup.asOwner);
      const revocations = yield* auditOf(setup, "makita.permission.revoke");
      assert.deepEqual(
        revocations.map((row) => [row.target, JSON.parse(row.detail)]),
        [[member, { space: setup.acmeId, reason: "revoked" }]],
      );

      // Removed from the Hub: her Personal space's row goes in the same commit, audited.
      const status = (value: string) =>
        setup.server.request(`/api/installation/users/${member}/status`, {
          body: { status: value },
          cookie: setup.ownerCookie,
        });
      assert.equal((yield* status("disabled")).status, 200);
      const disabled = yield* setup.makitaPermissions.listForSession.pipe(setup.asOwner);
      assert.equal(disabled.permissions[0]?.state, "user-inactive");
      assert.equal((yield* status("removed")).status, 200);
      const gone = yield* setup.makitaPermissions.listForSession.pipe(setup.asOwner);
      assert.deepEqual(gone.permissions, []);
      const all = yield* auditOf(setup, "makita.permission.revoke");
      assert.deepEqual(JSON.parse(all.at(-1)!.detail), {
        space: personalOf(member),
        reason: "user-removed",
      });
    }).pipe(Effect.scoped),
);

/**
 * Grants ticket 06: lending links. The lender of an AI account makes a link that works once, for
 * seven days; whoever holds it applies it to a Space where they decide, which accepts the loan.
 * Nobody learns more from a link than a loan shows, and a dead or unknown one is just invalid.
 */
import {
  type GrantCreatedOffer,
  type GrantId,
  GRANT_OPEN_OFFERS_PER_RESOURCE,
  type GrantOfferPreview,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

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

const at = "2026-11-16T00:00:00.000Z";
const NO_CAP = { kind: "ai-account", tokens: null, requests: null } as const;
const CAPPED = {
  kind: "ai-account",
  tokens: { amount: 50_000, period: "week" },
  requests: null,
} as const;

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
  // The Owner runs Acme, not Globex. Adam runs Acme, Ana works there, Linus is its Guest; Gus
  // runs Globex. Grecia shares no Space with anyone.
  yield* server.sql`
    INSERT OR IGNORE INTO space_memberships (space_id, user_id, role, created_at)
    VALUES (${acmeId}, ${ownerId}, 'admin', ${at})
  `;
  yield* server.sql`
    DELETE FROM space_memberships WHERE space_id = ${globexId} AND user_id = ${ownerId}
  `;
  const cookies = new Map<string, string>([[ownerId, owner]]);
  const person = Effect.fn(function* (
    id: string,
    membership?: { readonly spaceId: SpaceId; readonly role: "admin" | "member" | "guest" },
  ) {
    cookies.set(id, yield* addMember(server, { id, displayName: id }));
    if (membership !== undefined) {
      yield* joinOrganization(server, membership.spaceId, id, membership.role);
    }
    // An Admin acts as one only with a strong factor enrolled.
    if (membership?.role === "admin") {
      yield* server.sql`
        INSERT INTO user_totp (user_id, secret_ciphertext, enrolled_at, last_used_step)
        VALUES (${id}, 'sealed', ${at}, 0)
      `;
    }
    return UserId.make(id);
  });
  const ana = yield* person("ana", { spaceId: acmeId, role: "member" });
  const adam = yield* person("adam", { spaceId: acmeId, role: "admin" });
  const linus = yield* person("linus", { spaceId: acmeId, role: "guest" });
  const gus = yield* person("gus", { spaceId: globexId, role: "admin" });
  const grecia = yield* person("grecia");
  const aiAccount = Effect.fn(function* (
    id: string,
    owner: { readonly kind: "user" | "organization"; readonly id: string },
    type: "api-key" | "subscription" | "direct" = "subscription",
  ) {
    yield* server.sql`
      INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, created_at,
        updated_at, owner_kind, owner_id)
      VALUES (${id}, ${`${id} account`}, ${type}, 'claude', 1, 'ready', ${at}, ${at},
        ${owner.kind}, ${owner.id})
    `;
    return id;
  });
  const grants = Context.get(server.services, Grants.Grants);
  const offer = (who: UserId, aiAccountId: string, limits: unknown = NO_CAP) =>
    grants
      .createOffer({
        resource: { kind: "ai-account", aiAccountId: aiAccountId as never },
        limits: limits as never,
      })
      .pipe(CommandActor.actAs(who));
  const tokenOf = (created: GrantCreatedOffer) => {
    const token = new URLSearchParams(created.path.split("#")[1] ?? "").get("token");
    assert.isString(token);
    return token as string;
  };
  const read = (who: UserId, token: string) =>
    grants.readOffer({ token }).pipe(CommandActor.actAs(who));
  const claim = (who: UserId, token: string, spaceId: string) =>
    grants.claimOffer({ token, spaceId: SpaceId.make(spaceId) }).pipe(CommandActor.actAs(who));
  const refusal = (who: UserId, token: string, spaceId: string) =>
    claim(who, token, spaceId).pipe(
      Effect.flip,
      Effect.map((error) => error.reason),
    );
  const stateOf = (grantId: GrantId | string) =>
    server.sql<{
      readonly state: string;
      readonly targetId: string | null;
      readonly decidedBy: string | null;
    }>`
      SELECT state, target_id AS "targetId", decided_by AS "decidedBy" FROM grants
      WHERE grant_id = ${grantId}
    `.pipe(Effect.map((rows) => rows[0]));
  const audited = (grantId: GrantId | string) =>
    server.sql<{ readonly action: string; readonly detail: string; readonly spaceId: string }>`
      SELECT action, detail_json AS detail, space_id AS "spaceId" FROM audit_log
      WHERE target_kind = 'grant' AND target_id = ${grantId}
      ORDER BY rowid
    `;
  return {
    server,
    authenticator,
    cookies,
    ownerId,
    acmeId,
    globexId,
    ana,
    adam,
    linus,
    gus,
    grecia,
    aiAccount,
    grants,
    offer,
    tokenOf,
    read,
    claim,
    refusal,
    stateOf,
    audited,
  };
});

const personal = (userId: UserId) => `personal:${userId}`;
const valid = (preview: GrantOfferPreview) => {
  assert.equal(preview.status, "valid");
  return preview as Extract<GrantOfferPreview, { status: "valid" }>;
};

describe("Lending links", () => {
  it.effect(
    "a link lends an AI account once to a Space its lender does not know, and reveals no secret",
    () =>
      Effect.gen(function* () {
        const h = yield* hub;
        const sub = yield* h.aiAccount("ana-sub", { kind: "user", id: h.ana });
        const created = yield* h.offer(h.ana, sub, CAPPED);
        assert.equal(created.grant.state, "offered");
        assert.isNull(created.grant.target);
        assert.equal(created.grant.offer?.status, "open");
        assert.isNull(created.url, "no public address configured: the client's origin is used");
        assert.match(created.path, /^\/grants\/offer#token=[A-Za-z0-9_-]{43}$/);
        const token = h.tokenOf(created);

        // The Hub keeps only its hash.
        const [stored] = yield* h.server.sql<{ readonly hash: string; readonly expires: string }>`
          SELECT offer_token_hash AS hash, offer_expires_at AS expires FROM grants
          WHERE grant_id = ${created.grant.id}
        `;
        assert.isString(stored?.hash);
        assert.notInclude(stored?.hash ?? "", token);
        assert.equal(stored?.expires, created.grant.offer?.expiresAt);
        const millis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
        assert.equal(
          millis(stored?.expires ?? "") - millis(created.grant.createdAt),
          Duration.toMillis(Duration.days(7)),
        );

        // Grecia shares no Space with Ana: she sees what is lent, by whom, with which caps, and
        // her own Space to apply it to. Nothing else: no ids, no credential.
        const preview = valid(yield* h.read(h.grecia, token));
        assert.deepEqual(preview.resource, {
          kind: "ai-account",
          name: "ana-sub account",
          aiAccount: { provider: "claude", type: "subscription" },
        });
        assert.deepEqual(preview.lender, { kind: "user", name: "ana" });
        assert.deepEqual(preview.limits, CAPPED);
        assert.deepEqual(
          preview.spaces.map((space) => [space.spaceId, space.alreadyGranted]),
          [[personal(h.grecia), false]],
        );
        assert.notInclude(JSON.stringify(preview), '"id"');
        assert.notInclude(JSON.stringify(preview), created.grant.id);

        // Applying it accepts it: active in her Personal space, decided by her.
        const claimed = yield* h.claim(h.grecia, token, personal(h.grecia));
        assert.equal(claimed.id, created.grant.id);
        assert.equal(claimed.state, "active");
        assert.equal(claimed.target?.spaceId, personal(h.grecia));
        assert.deepEqual(claimed.limits, CAPPED);
        assert.deepEqual(yield* h.stateOf(created.grant.id), {
          state: "active",
          targetId: personal(h.grecia),
          decidedBy: h.grecia,
        });

        // Once: a second read or application finds nothing.
        assert.deepEqual(yield* h.read(h.gus, token), { status: "invalid" });
        assert.equal(yield* h.refusal(h.gus, token, personal(h.gus)), "not-found");

        // Ana sees it given, used; Grecia sees it received.
        const given = yield* h.grants.listGiven.pipe(CommandActor.actAs(h.ana));
        assert.deepEqual(
          given.grants.map((grant) => [grant.id, grant.state, grant.offer?.status]),
          [[created.grant.id, "active", "used"]],
        );
        const received = yield* h.grants.listReceived({}).pipe(CommandActor.actAs(h.grecia));
        assert.deepEqual(
          received.grants.map((grant) => [grant.id, grant.can.return]),
          [[created.grant.id, true]],
        );

        // Audited as a link made by Ana, then accepted in Grecia's Space through it; never with
        // the token or its hash.
        const audit = yield* h.audited(created.grant.id);
        assert.deepEqual(
          audit.map((row) => row.action),
          ["grant.offer", "grant.accept"],
        );
        assert.equal(audit[1]?.spaceId, personal(h.grecia));
        assert.equal(JSON.parse(audit[1]?.detail ?? "{}").via, "link");
        for (const row of audit) {
          assert.notInclude(row.detail, token);
          assert.notInclude(row.detail, stored?.hash ?? "");
        }
      }),
  );

  it.effect("only someone who decides in a Space applies a link there", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const key = yield* h.aiAccount("ana-key", { kind: "user", id: h.ana }, "api-key");
      const token = h.tokenOf(yield* h.offer(h.ana, key));

      // In Acme: not its Member Ana (she lends it), nor its Guest; not someone outside it.
      assert.equal(yield* h.refusal(h.linus, token, h.acmeId), "not-allowed");
      assert.equal(yield* h.refusal(h.grecia, token, h.acmeId), "not-allowed");
      assert.equal(yield* h.refusal(h.gus, token, h.acmeId), "not-allowed");
      // In Globex the Owner is not an Admin; nor is anyone's Personal space theirs to decide on.
      assert.equal(yield* h.refusal(h.ownerId, token, h.globexId), "not-allowed");
      assert.equal(yield* h.refusal(h.ownerId, token, personal(h.grecia)), "not-allowed");
      assert.equal(yield* h.refusal(h.adam, token, personal(h.linus)), "not-allowed");
      // Never to the lender's own Space: it is hers already.
      assert.equal(yield* h.refusal(h.ana, token, personal(h.ana)), "not-allowed");
      // A Space that does not exist answers like one that is not yours.
      assert.equal(yield* h.refusal(h.adam, token, "org-nowhere"), "not-allowed");

      // What each sees to apply it to: only the Spaces they decide in, never the lender's own.
      const spacesOf = (who: UserId) =>
        h
          .read(who, token)
          .pipe(Effect.map((preview) => valid(preview).spaces.map((space) => space.spaceId)));
      assert.deepEqual(yield* spacesOf(h.ana), []);
      assert.deepEqual(yield* spacesOf(h.linus), [personal(h.linus)]);
      assert.sameMembers(yield* spacesOf(h.adam), [h.acmeId, personal(h.adam)]);
      assert.sameMembers(yield* spacesOf(h.ownerId), [h.acmeId, personal(h.ownerId)]);

      // Every refusal left the link as it was; Acme's Admin applies it there.
      const claimed = yield* h.claim(h.adam, token, h.acmeId);
      assert.deepEqual([claimed.state, claimed.target?.spaceId], ["active", h.acmeId]);
    }),
  );

  it.effect("a used, expired or cancelled link does not work, and reading says only invalid", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const key = yield* h.aiAccount("ana-key", { kind: "user", id: h.ana }, "api-key");
      // Unknown.
      assert.deepEqual(yield* h.read(h.grecia, "no-such-link"), { status: "invalid" });
      assert.equal(yield* h.refusal(h.grecia, "no-such-link", personal(h.grecia)), "not-found");

      // Cancelled by Ana before anyone applied it; nobody else cancels it.
      const toCancel = yield* h.offer(h.ana, key);
      const byOther = yield* h.grants
        .cancel({ grantId: toCancel.grant.id })
        .pipe(CommandActor.actAs(h.grecia), Effect.flip);
      assert.equal(byOther.reason, "not-found");
      const byAdmin = yield* h.grants
        .cancel({ grantId: toCancel.grant.id })
        .pipe(CommandActor.actAs(h.adam), Effect.flip);
      assert.equal(byAdmin.reason, "not-found");
      const cancelled = yield* h.grants
        .cancel({ grantId: toCancel.grant.id })
        .pipe(CommandActor.actAs(h.ana));
      assert.deepEqual(
        [cancelled.state, cancelled.target, cancelled.offer?.status],
        ["cancelled", null, "cancelled"],
      );
      const cancelledToken = h.tokenOf(toCancel);
      assert.deepEqual(yield* h.read(h.grecia, cancelledToken), { status: "invalid" });
      assert.equal(yield* h.refusal(h.grecia, cancelledToken, personal(h.grecia)), "not-found");
      assert.deepEqual(
        (yield* h.audited(toCancel.grant.id)).map((row) => row.action),
        ["grant.offer", "grant.cancel"],
      );

      // Expired: seven days later.
      const toExpire = yield* h.offer(h.ana, key);
      const expiringToken = h.tokenOf(toExpire);
      yield* TestClock.adjust(Duration.days(7));
      assert.deepEqual(yield* h.read(h.grecia, expiringToken), { status: "invalid" });
      assert.equal(yield* h.refusal(h.grecia, expiringToken, personal(h.grecia)), "not-found");
      // Ana's list says why each one is dead; an expired one cannot be cancelled any more.
      const given = yield* h.grants.listGiven.pipe(CommandActor.actAs(h.ana));
      assert.sameDeepMembers(
        given.grants.map((grant) => [grant.id, grant.offer?.status, grant.can.cancel]),
        [
          [toCancel.grant.id, "cancelled", false],
          [toExpire.grant.id, "expired", false],
        ],
      );
      assert.equal(
        yield* h.stateOf(toExpire.grant.id).pipe(Effect.map((row) => row?.state)),
        "offered",
      );
    }),
  );

  it.effect("a second loan to the same Space is refused, and the link still works elsewhere", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const key = yield* h.aiAccount("ana-key", { kind: "user", id: h.ana }, "api-key");
      const lent = yield* h.grants
        .give(
          {
            resource: { kind: "ai-account", aiAccountId: key as never },
            spaceId: h.acmeId,
            limits: NO_CAP,
          },
          { strongFactor: false },
        )
        .pipe(CommandActor.actAs(h.ana));
      assert.equal(lent.state, "pending");
      const created = yield* h.offer(h.ana, key);
      const token = h.tokenOf(created);
      const preview = valid(yield* h.read(h.adam, token));
      assert.sameDeepMembers(
        preview.spaces.map((space) => [space.spaceId, space.alreadyGranted]),
        [
          [h.acmeId, true],
          [personal(h.adam), false],
        ],
      );
      assert.equal(yield* h.refusal(h.adam, token, h.acmeId), "already-granted");
      assert.equal((yield* h.stateOf(created.grant.id))?.state, "offered");
      const claimed = yield* h.claim(h.adam, token, personal(h.adam));
      assert.equal(claimed.state, "active");
    }),
  );

  it.effect("two people applying the same link at once: one gets it", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const key = yield* h.aiAccount("ana-key", { kind: "user", id: h.ana }, "api-key");
      const token = h.tokenOf(yield* h.offer(h.ana, key));
      const results = yield* Effect.all(
        [
          Effect.result(h.claim(h.grecia, token, personal(h.grecia))),
          Effect.result(h.claim(h.gus, token, personal(h.gus))),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const live = yield* h.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM grants WHERE resource_id = ${key} AND state = 'active'
      `;
      assert.equal(live[0]?.n, 1);
    }),
  );

  it.effect(
    "a link dies when its maker may no longer lend, or the account is gone or another's",
    () =>
      Effect.gen(function* () {
        const h = yield* hub;
        // Acme's account, linked by its Admin Adam, who then becomes a Member.
        const acmes = yield* h.aiAccount("acme-key", { kind: "organization", id: h.acmeId });
        const byAdam = h.tokenOf(yield* h.offer(h.adam, acmes));
        valid(yield* h.read(h.grecia, byAdam));
        yield* h.server.sql`
          UPDATE space_memberships SET role = 'member'
          WHERE space_id = ${h.acmeId} AND user_id = ${h.adam}
        `;
        assert.deepEqual(yield* h.read(h.grecia, byAdam), { status: "invalid" });
        assert.equal(yield* h.refusal(h.grecia, byAdam, personal(h.grecia)), "not-found");

        // Ana's links: her account deleted; another given to someone else; Ana turned off.
        const deleted = yield* h.aiAccount("ana-deleted", { kind: "user", id: h.ana });
        const deletedToken = h.tokenOf(yield* h.offer(h.ana, deleted));
        yield* h.server
          .sql`UPDATE ai_accounts SET deleted_at = ${at} WHERE account_id = ${deleted}`;
        assert.deepEqual(yield* h.read(h.grecia, deletedToken), { status: "invalid" });

        const moved = yield* h.aiAccount("ana-moved", { kind: "user", id: h.ana });
        const movedToken = h.tokenOf(yield* h.offer(h.ana, moved));
        yield* h.server.sql`
          UPDATE ai_accounts SET owner_kind = 'organization', owner_id = ${h.acmeId}
          WHERE account_id = ${moved}
        `;
        assert.deepEqual(yield* h.read(h.grecia, movedToken), { status: "invalid" });

        const hers = yield* h.aiAccount("ana-sub", { kind: "user", id: h.ana });
        const hersToken = h.tokenOf(yield* h.offer(h.ana, hers));
        yield* h.server.sql`UPDATE users SET disabled_at = ${at} WHERE user_id = ${h.ana}`;
        assert.deepEqual(yield* h.read(h.grecia, hersToken), { status: "invalid" });
        assert.equal(yield* h.refusal(h.grecia, hersToken, personal(h.grecia)), "not-found");
      }),
  );

  it.effect("only the lender makes a link, never of a direct account, ten at most", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const key = yield* h.aiAccount("ana-key", { kind: "user", id: h.ana }, "api-key");
      const acmes = yield* h.aiAccount("acme-key", { kind: "organization", id: h.acmeId });
      const direct = yield* h.aiAccount("ana-direct", { kind: "user", id: h.ana }, "direct");
      const refused = (who: UserId, aiAccountId: string, limits: unknown = NO_CAP) =>
        h.offer(who, aiAccountId, limits).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      // Not the Owner, nor an Admin, for Ana's; not a Member, a Guest or another Organization's
      // Admin for Acme's. Whoever it is not even near is told it does not exist (Grants 13).
      assert.equal(yield* refused(h.ownerId, key), "not-found");
      assert.equal(yield* refused(h.adam, key), "not-found");
      assert.equal(yield* refused(h.ana, acmes), "not-allowed");
      assert.equal(yield* refused(h.linus, acmes), "not-allowed");
      assert.equal(yield* refused(h.gus, acmes), "not-found");
      // Acme's Admins do, and any of them sees and cancels it; its Members do not see it.
      const acmeLink = yield* h.offer(h.adam, acmes);
      const ownerSees = yield* h.grants.listGiven.pipe(CommandActor.actAs(h.ownerId));
      assert.include(
        ownerSees.grants.map((grant) => grant.id as string),
        acmeLink.grant.id,
      );
      const anaSees = yield* h.grants.listGiven.pipe(CommandActor.actAs(h.ana));
      assert.notInclude(
        anaSees.grants.map((grant) => grant.id as string),
        acmeLink.grant.id,
      );
      const byMember = yield* h.grants
        .cancel({ grantId: acmeLink.grant.id })
        .pipe(CommandActor.actAs(h.ana), Effect.flip);
      assert.equal(byMember.reason, "not-found");
      const byOwner = yield* h.grants
        .cancel({ grantId: acmeLink.grant.id })
        .pipe(CommandActor.actAs(h.ownerId));
      assert.equal(byOwner.state, "cancelled");
      // Never a direct account, nor limits of another kind (machines: «Lending links of machines»).
      assert.equal(yield* refused(h.ana, direct), "not-lendable");
      assert.equal(
        yield* refused(h.ana, key, {
          kind: "environment",
          cpus: 1,
          memoryBytes: 1,
          pids: 1,
          diskBytes: 1,
        }),
        "invalid-limits",
      );

      // Ten open links per account; a cancelled or expired one does not count.
      const made: Array<GrantCreatedOffer> = [];
      for (let index = 0; index < GRANT_OPEN_OFFERS_PER_RESOURCE; index += 1) {
        made.push(yield* h.offer(h.ana, key));
      }
      assert.equal(yield* refused(h.ana, key), "too-many-offers");
      yield* h.grants.cancel({ grantId: made[0]!.grant.id }).pipe(CommandActor.actAs(h.ana));
      made.push(yield* h.offer(h.ana, key));
      assert.equal(yield* refused(h.ana, key), "too-many-offers");
      yield* TestClock.adjust(Duration.days(7));
      yield* h.offer(h.ana, key);
    }),
  );

  it.effect("without a signed-in User a link reveals nothing; guessing is throttled", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const key = yield* h.aiAccount("ana-key", { kind: "user", id: h.ana }, "api-key");
      const token = h.tokenOf(yield* h.offer(h.ana, key));
      const anonymous = yield* h.grants.readOffer({ token }).pipe(Effect.flip);
      assert.equal(anonymous.reason, "not-allowed");
      assert.notInclude(anonymous.message, "ana");
      const anonymousClaim = yield* h.grants
        .claimOffer({ token, spaceId: SpaceId.make(personal(h.grecia)) })
        .pipe(Effect.flip);
      assert.equal(anonymousClaim.reason, "not-allowed");

      // Five wrong links are forgiven; then Grecia waits, even with a good one. Gus does not.
      for (let index = 0; index < 5; index += 1) {
        assert.deepEqual(yield* h.read(h.grecia, `guess-${index}`), { status: "invalid" });
      }
      const locked = yield* h.read(h.grecia, token).pipe(Effect.flip);
      assert.equal(locked.reason, "throttled");
      assert.equal(yield* h.refusal(h.grecia, token, personal(h.grecia)), "throttled");
      valid(yield* h.read(h.gus, token));
      // Later she may again.
      yield* TestClock.adjust(Duration.minutes(2));
      valid(yield* h.read(h.grecia, token));
    }),
  );
});

// Grants ticket 15 (follow-up of 06): a machine lent by link. Applying it makes the loan active, so
// it needs the decider's strong factor (over HTTP, as accepting) and opens their Sandbox.

const CLAIM = "/api/grants/claim-offer";
const MACHINE_LIMITS = {
  kind: "environment",
  cpus: 1,
  memoryBytes: 2 ** 31,
  pids: 256,
  diskBytes: 2 ** 33,
} as const;
/** A proof no one could pass: a refusal must come before it is checked, or because of it. */
const BOGUS_REAUTH = { method: "password", password: "nope", totpCode: "000000" };

type Hub = Effect.Success<typeof hub>;

const machineOf = Effect.fn(function* (h: Hub, id: string, ownerUserId: UserId) {
  yield* h.server.sql`
    INSERT INTO environments (environment_id, name, kind, mode, owner_user_id, space_id,
      credential_hash, credential_issued_at, registered_at)
    VALUES (${id}, ${`${id} box`}, 'external', 'personal', ${ownerUserId}, NULL, ${`hash-${id}`},
      ${at}, ${at})
  `;
  return id;
});
const machineOffer = (h: Hub, who: UserId, environmentId: string) =>
  h.grants
    .createOffer({
      resource: { kind: "environment", environmentId: environmentId as never },
      limits: MACHINE_LIMITS,
    })
    .pipe(CommandActor.actAs(who));
const claimOverHttp = (h: Hub, who: UserId, token: string, spaceId: string, reauth?: unknown) =>
  h.server.request(CLAIM, {
    cookie: h.cookies.get(who) ?? "",
    body: { token, spaceId, ...(reauth === undefined ? {} : { reauth }) },
  });
/** The Sandboxes the Hub opened for a Grant (Environments of their own). */
const sandboxesOf = (h: Hub, grantId: string) =>
  h.server.sql<{ readonly environmentId: string; readonly spaceId: string | null }>`
    SELECT environment_id AS "environmentId", space_id AS "spaceId" FROM environments
    WHERE grant_id = ${grantId} AND revoked_at IS NULL
  `;

describe("Lending links of machines", () => {
  it.effect(
    "a machine's link is made without a factor; applying it needs the decider's and opens their Sandbox",
    () =>
      Effect.gen(function* () {
        const h = yield* hub;
        const vps = yield* machineOf(h, "ana-vps", h.ana);
        const created = yield* machineOffer(h, h.ana, vps);
        assert.equal(created.grant.state, "offered");
        assert.equal(created.grant.resource.kind, "environment");
        const token = h.tokenOf(created);

        // Grecia shares no Space with Ana: she reads what is lent and her Space to apply it to.
        const preview = valid(yield* h.read(h.grecia, token));
        assert.deepEqual(preview.resource, { kind: "environment", name: "ana-vps box" });
        assert.deepEqual(preview.limits, MACHINE_LIMITS);
        assert.notInclude(JSON.stringify(preview), "hash-ana-vps");

        // Over WS (no factor can ride there) and over HTTP without one, or a wrong one: refused,
        // nothing opened, and the link still works.
        assert.equal(yield* h.refusal(h.ownerId, token, h.acmeId), "strong-factor-required");
        assert.equal((yield* claimOverHttp(h, h.ownerId, token, h.acmeId)).status, 403);
        assert.equal(
          (yield* claimOverHttp(h, h.ownerId, token, h.acmeId, BOGUS_REAUTH)).status,
          403,
        );
        assert.equal((yield* h.stateOf(created.grant.id))?.state, "offered");
        assert.deepEqual(yield* sandboxesOf(h, created.grant.id), []);

        // The Owner runs Acme: with their passkey it is applied there, and Acme's Sandbox opens.
        const claimed = yield* claimOverHttp(
          h,
          h.ownerId,
          token,
          h.acmeId,
          yield* passkeyReauth(h.server, h.authenticator),
        );
        assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
        assert.equal(claimed.body.state, "active");
        assert.deepEqual(yield* h.stateOf(created.grant.id), {
          state: "active",
          targetId: h.acmeId,
          decidedBy: h.ownerId,
        });
        const opened = yield* sandboxesOf(h, created.grant.id);
        assert.deepEqual(
          opened.map((sandbox) => sandbox.spaceId),
          [h.acmeId],
        );
        const audit = yield* h.audited(created.grant.id);
        assert.deepEqual(
          audit.map((row) => row.action),
          ["grant.offer", "grant.accept"],
        );
        assert.equal(JSON.parse(audit[1]?.detail ?? "{}").via, "link");
        for (const row of audit) assert.notInclude(row.detail, token);

        // Once: nobody applies it again.
        assert.deepEqual(yield* h.read(h.grecia, token), { status: "invalid" });
        const again = yield* claimOverHttp(
          h,
          h.ownerId,
          token,
          personal(h.ownerId),
          yield* passkeyReauth(h.server, h.authenticator),
        );
        assert.equal(again.status, 404);
      }),
  );

  it.effect("only someone who decides in a Space applies a machine's link there", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* machineOf(h, "ana-vps", h.ana);
      const created = yield* machineOffer(h, h.ana, vps);
      const token = h.tokenOf(created);
      // Refused before any factor is asked for: Acme's Member (its lender) and Guest, a stranger
      // and Globex's Admin in Acme; the Owner where they do not decide; the lender in her own.
      for (const [who, spaceId] of [
        [h.ana, h.acmeId],
        [h.linus, h.acmeId],
        [h.grecia, h.acmeId],
        [h.gus, h.acmeId],
        [h.ownerId, h.globexId],
        [h.ownerId, personal(h.grecia)],
        [h.ana, personal(h.ana)],
      ] as const) {
        assert.equal(yield* h.refusal(who, token, spaceId), "not-allowed", `${who} in ${spaceId}`);
        assert.equal(
          (yield* claimOverHttp(h, who, token, spaceId, BOGUS_REAUTH)).status,
          403,
          `${who} in ${spaceId} over HTTP`,
        );
      }
      assert.equal((yield* h.stateOf(created.grant.id))?.state, "offered");
      // The Owner in their own Personal space: theirs to decide on.
      const mine = yield* claimOverHttp(
        h,
        h.ownerId,
        token,
        personal(h.ownerId),
        yield* passkeyReauth(h.server, h.authenticator),
      );
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      assert.equal(
        (mine.body.target as { readonly spaceId?: string } | undefined)?.spaceId,
        personal(h.ownerId),
      );
    }),
  );

  it.effect(
    "a machine's link dies with the machine, its personal mode or its lender's sign-in; ten open at most",
    () =>
      Effect.gen(function* () {
        const h = yield* hub;
        const dead = Effect.fn(function* (token: string) {
          assert.deepEqual(yield* h.read(h.grecia, token), { status: "invalid" });
          assert.equal(yield* h.refusal(h.grecia, token, personal(h.grecia)), "not-found");
        });
        const revoked = yield* machineOf(h, "ana-revoked", h.ana);
        const revokedToken = h.tokenOf(yield* machineOffer(h, h.ana, revoked));
        yield* h.server
          .sql`UPDATE environments SET revoked_at = ${at} WHERE environment_id = ${revoked}`;
        yield* dead(revokedToken);

        const dedicated = yield* machineOf(h, "ana-dedicated", h.ana);
        const dedicatedToken = h.tokenOf(yield* machineOffer(h, h.ana, dedicated));
        yield* h.server
          .sql`UPDATE environments SET mode = 'dedicated', owner_user_id = NULL, space_id = ${h.acmeId}
            WHERE environment_id = ${dedicated}`;
        yield* dead(dedicatedToken);

        // Nobody but its owner makes a link of it; a dedicated machine has none.
        const vps = yield* machineOf(h, "ana-vps", h.ana);
        for (const who of [h.ownerId, h.adam]) {
          const refused = yield* machineOffer(h, who, vps).pipe(Effect.flip);
          assert.equal(refused.reason, "not-found");
        }
        assert.equal(
          (yield* machineOffer(h, h.ana, dedicated).pipe(Effect.flip)).reason,
          "not-lendable",
        );
        // Ten open links per machine.
        const made: Array<string> = [];
        for (let index = 0; index < GRANT_OPEN_OFFERS_PER_RESOURCE; index += 1) {
          made.push(h.tokenOf(yield* machineOffer(h, h.ana, vps)));
        }
        const tooMany = yield* machineOffer(h, h.ana, vps).pipe(Effect.flip);
        assert.equal(tooMany.reason, "too-many-offers");
        assert.include(tooMany.message, "machine");

        // Ana turned off: she can no longer lend it, so none of her links work.
        yield* h.server.sql`UPDATE users SET disabled_at = ${at} WHERE user_id = ${h.ana}`;
        yield* dead(made[0]!);
      }),
  );

  it.effect("a machine that cannot run a Sandbox now refuses its link; the link stays usable", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* machineOf(h, "ana-vps", h.ana);
      const created = yield* machineOffer(h, h.ana, vps);
      const token = h.tokenOf(created);
      const host = (ready: boolean) =>
        JSON.stringify({
          ready,
          reason: ready ? null : "Docker is not running.",
          limitSupport: { cpus: true, memory: true, pids: true, note: null },
          reachablePorts: [],
          hostCpus: 4,
          hostMemoryBytes: 2 ** 33,
          hostFreeBytes: null,
          hostTotalBytes: null,
        });
      yield* h.server.sql`
        UPDATE environments SET sandbox_host_json = ${host(false)} WHERE environment_id = ${vps}
      `;
      // Refused before the factor is checked: the wrong one is never read.
      const refused = yield* claimOverHttp(h, h.ownerId, token, h.acmeId, BOGUS_REAUTH);
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.include(JSON.stringify(refused.body), "Docker is not running.");
      assert.equal((yield* h.stateOf(created.grant.id))?.state, "offered");
      // Making a new link of it is refused alike.
      assert.equal((yield* machineOffer(h, h.ana, vps).pipe(Effect.flip)).reason, "host-not-ready");
      yield* h.server.sql`
        UPDATE environments SET sandbox_host_json = ${host(true)} WHERE environment_id = ${vps}
      `;
      const claimed = yield* claimOverHttp(
        h,
        h.ownerId,
        token,
        h.acmeId,
        yield* passkeyReauth(h.server, h.authenticator),
      );
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    }),
  );

  it.effect("a Sandbox that cannot be opened leaves the link offered and no loan active", () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const vps = yield* machineOf(h, "ana-vps", h.ana);
      const created = yield* machineOffer(h, h.ana, vps);
      const token = h.tokenOf(created);
      // Opening the Sandbox fails inside the transaction that would make the loan active.
      yield* h.server.sql`
        CREATE TRIGGER no_lent_sandbox BEFORE INSERT ON environments
        WHEN NEW.grant_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'no Sandbox today'); END
      `;
      const failed = yield* claimOverHttp(
        h,
        h.ownerId,
        token,
        h.acmeId,
        yield* passkeyReauth(h.server, h.authenticator),
      );
      assert.equal(failed.status, 500, JSON.stringify(failed.body));
      assert.deepEqual(yield* h.stateOf(created.grant.id), {
        state: "offered",
        targetId: null,
        decidedBy: null,
      });
      const active = yield* h.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM grants WHERE resource_id = ${vps} AND state = 'active'
      `;
      assert.equal(active[0]?.n, 0);
      assert.deepEqual(yield* sandboxesOf(h, created.grant.id), []);
      assert.deepEqual(
        (yield* h.audited(created.grant.id)).map((row) => row.action),
        ["grant.offer"],
      );
      // Once it can open, the same link applies.
      yield* h.server.sql`DROP TRIGGER no_lent_sandbox`;
      const claimed = yield* claimOverHttp(
        h,
        h.ownerId,
        token,
        h.acmeId,
        yield* passkeyReauth(h.server, h.authenticator),
      );
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      assert.equal((yield* sandboxesOf(h, created.grant.id)).length, 1);
    }),
  );
});

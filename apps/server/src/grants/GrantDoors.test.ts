/**
 * Grants ticket 13: the Owner, the Admin, Member and Guest of Acme and Globex, and Ana (in no
 * Organization) call every door of Grants (WS handlers call these services one to one; HTTP over
 * HTTP). Nobody sees another's waiting loans, usage outside their loans, a lent Secret's value or a
 * lending link's token; nobody but its sides changes a loan; a new Grants door not called fails.
 */
// @effect-diagnostics globalJsonInEffect:off -- answers are searched as text.
// @effect-diagnostics nodeBuiltinImport:off -- a link's hash, as the Hub keeps it, to look for.
import * as NodeCrypto from "node:crypto";

import {
  AiAccountGrantLimits,
  GrantId,
  type SpaceId,
  SpaceId as SpaceIdSchema,
  UserId,
  type VaultGroupId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Tracer from "effect/Tracer";

import * as AllowedAiAccounts from "../ai/AllowedAiAccounts.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { HTTP_ENDPOINT_RULES, MCP_TOOL_RULES, RAW_ROUTE_RULES } from "../auth/DoorRules.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EffectiveVaults from "../vaults/EffectiveVaults.ts";
import { userOwner } from "../vaults/VaultGroups.testkit.ts";
import * as Vaults from "../vaults/Vaults.ts";
import * as Grants from "./Grants.ts";
import { lendAiAccount, lendVaultGroup } from "./Grants.testkit.ts";

const SECRET = "ana-lent-secret-value-7777";
const NO_CAP = { kind: "ai-account", tokens: null, requests: null } as const;
const CAPPED: AiAccountGrantLimits = {
  kind: "ai-account",
  tokens: { amount: 1000, period: "day" },
  requests: null,
};
const AT = "2026-11-20T00:00:00.000Z";

/** Doors about Grants called in other files, with where. */
const SWEPT_ELSEWHERE: Record<string, string> = {
  "ws:grants.claimOffer":
    "GrantOffers.test.ts: anyone may apply a link to a Space they decide for (that is a link)",
  // Not a loan: the one-use join an SSH install run is granted (SshInstall tests).
  "http:environments.grantJoin": "SshInstall.test.ts",
};
const RE_GRANTS = /grant/iu;

const team = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const ownerCookie = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: ownerCookie,
    });
    return SpaceIdSchema.make(made.body.id as string);
  });
  const acmeId = yield* organization("Acme");
  const globexId = yield* organization("Globex");
  // The Owner made both but works in neither: no Membership.
  yield* server.sql`DELETE FROM space_memberships WHERE user_id = ${ownerId}`;
  const person = Effect.fn(function* (
    id: string,
    spaceId: SpaceId | null,
    role: "admin" | "member" | "guest" | null,
  ) {
    const cookie = yield* addMember(server, { id, displayName: id });
    if (spaceId !== null && role !== null) yield* joinOrganization(server, spaceId, id, role);
    if (role === "admin") {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', ${AT})`;
    }
    return { name: id, id: UserId.make(id), cookie };
  });
  const owner = { name: "owner", id: ownerId, cookie: ownerCookie };
  const adam = yield* person("adam", acmeId, "admin");
  const mia = yield* person("mia", acmeId, "member");
  const linus = yield* person("linus", acmeId, "guest");
  const gus = yield* person("gus", globexId, "admin");
  const gina = yield* person("gina", globexId, "member");
  const otto = yield* person("otto", globexId, "guest");
  const ana = yield* person("ana", null, null);
  const people = [owner, adam, mia, linus, gus, gina, otto, ana];
  yield* Context.get(server.services, SpaceDirectory.SpaceDirectory).membershipsChanged(
    people.map((who) => who.id),
  );
  const grants = Context.get(server.services, Grants.Grants);
  const vaults = Context.get(server.services, Vaults.Vaults);

  // Ana's: an API key lent to Acme, another waiting for Globex and in an open link, a group with
  // a Secret lent to Acme and one of its defaults.
  const account = (id: string) => server.sql`
    INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, created_at,
      updated_at, owner_kind, owner_id)
    VALUES (${id}, ${`${id} account`}, 'api-key', 'claude', 1, 'ready', ${AT}, ${AT}, 'user', 'ana')
  `;
  yield* account("ana-key");
  yield* account("ana-key-2");
  const acmeKeyGrant = yield* lendAiAccount(server.sql, {
    accountId: "ana-key",
    lender: { kind: "user", id: ana.id },
    spaceId: acmeId,
  });
  const globexPending = GrantId.make("grant-globex-pending");
  yield* server.sql`
    INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
      target_kind, target_id, state, limits_json, created_at, created_by)
    VALUES (${globexPending}, 'ai-account', 'ana-key-2', 'user', ${ana.id}, 'space', ${globexId},
      'pending', '{"kind":"ai-account","tokens":null,"requests":null}', ${AT}, ${ana.id})
  `;
  const group = yield* vaults
    .create({ name: "Ana tools", owner: userOwner(ana.id) })
    .pipe(CommandActor.actAs(ana.id));
  yield* vaults
    .putEntry({ vaultId: group.id, name: "ANA_TOKEN", value: Redacted.make(SECRET) })
    .pipe(CommandActor.actAs(ana.id));
  const acmeGroupGrant = yield* lendVaultGroup(server.sql, {
    vaultId: group.id,
    lender: { kind: "user", id: ana.id },
    spaceId: acmeId,
  });
  yield* server.sql`
    INSERT INTO space_default_vaults (space_id, group_id, position) VALUES (${acmeId}, ${group.id}, 0)
  `;
  return {
    server,
    ownerId,
    acmeId,
    globexId,
    people,
    owner,
    adam,
    mia,
    linus,
    gus,
    gina,
    otto,
    ana,
    grants,
    vaults,
    group: group.id as VaultGroupId,
    acmeKeyGrant,
    globexPending,
    acmeGroupGrant,
  };
});

const stateOf = (t: Effect.Success<typeof team>, grantId: string) =>
  t.server.sql<{ readonly state: string; readonly limits: string }>`
    SELECT state, limits_json AS limits FROM grants WHERE grant_id = ${grantId}
  `.pipe(Effect.map((rows) => `${rows[0]?.state}:${rows[0]?.limits}`));

/** A Thread of `ownerUserId` in `spaceId`, as the orchestrator stamps it. */
const threadOf = Effect.fn(function* (
  t: Effect.Success<typeof team>,
  id: string,
  ownerUserId: UserId,
  spaceId: SpaceId,
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* t.server.sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json, space_id, owner_user_id
    ) VALUES (
      ${id}, 'project:none', ${id}, 'codex', 'full-access', 'default', ${now}, ${now}, '{}',
      ${spaceId}, ${ownerUserId}
    )
  `;
  return id as never;
});

it.effect(
  "every Grants door, called by the Owner, two Organizations' roles and Ana: each sees and changes only its own side",
  () =>
    Effect.gen(function* () {
      const t = yield* team;
      // Ana's lending link, made through the door, its token answered once.
      const made = yield* t.grants
        .createOffer({
          resource: { kind: "ai-account", aiAccountId: "ana-key-2" as never },
          limits: NO_CAP,
        })
        .pipe(CommandActor.actAs(t.ana.id));
      const token = /#token=([A-Za-z0-9_-]+)/.exec(made.path)?.[1] ?? "";
      assert.isAbove(token.length, 20);
      const tokenHash = NodeCrypto.createHash("sha256").update(token).digest("hex");
      const answers: Array<{ readonly who: string; readonly door: string; readonly text: string }> =
        [];
      const swept = new Set<string>(["ws:grants.createOffer"]);
      const record = (who: string, door: string, value: unknown) => {
        swept.add(door);
        answers.push({ who, door, text: JSON.stringify(value) ?? "" });
      };
      const refusedOrAnswer = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, value: error })),
        );

      const listedGiven = new Map<string, ReadonlyArray<string>>();
      const listedReceived = new Map<string, ReadonlyArray<string>>();
      const vaultUse = new Map<string, boolean>();
      for (const who of t.people) {
        const as = CommandActor.actAs(who.id);
        const given = yield* t.grants.listGiven.pipe(as);
        record(who.name, "ws:grants.listGiven", given);
        listedGiven.set(
          who.name,
          given.grants.map((grant) => grant.id),
        );
        const received = yield* t.grants.listReceived({}).pipe(as);
        record(who.name, "ws:grants.listReceived", received);
        listedReceived.set(
          who.name,
          received.grants.map((grant) => grant.id),
        );
        record(
          who.name,
          "ws:grants.targets",
          yield* refusedOrAnswer(
            t.grants.targets({ resource: { kind: "ai-account", aiAccountId: "ana-key" as never } }),
          ).pipe(as),
        );
        record(
          who.name,
          "ws:grants.readOffer",
          yield* refusedOrAnswer(t.grants.readOffer({ token })).pipe(as),
        );
        const usage = yield* refusedOrAnswer(
          t.grants.vaultUsage({ grantId: t.acmeGroupGrant }),
        ).pipe(as);
        record(who.name, "ws:grants.vaultUsage", usage);
        vaultUse.set(who.name, usage.ok);
        record(
          who.name,
          "ws:grants.migrationReviews",
          yield* refusedOrAnswer(t.grants.migrationReviews).pipe(as),
        );
        // Changes, by whoever is on neither side: refused, nothing moves.
        const before = [
          yield* stateOf(t, t.acmeKeyGrant),
          yield* stateOf(t, t.globexPending),
        ].join();
        if (who.name !== "gus") {
          record(
            who.name,
            "ws:grants.reject",
            yield* refusedOrAnswer(t.grants.reject({ grantId: t.globexPending })).pipe(as),
          );
        }
        if (who.name !== "ana") {
          record(
            who.name,
            "ws:grants.cancel",
            yield* refusedOrAnswer(t.grants.cancel({ grantId: t.globexPending })).pipe(as),
          );
          record(
            who.name,
            "ws:grants.setLimits",
            yield* refusedOrAnswer(
              t.grants.setLimits({ grantId: t.acmeKeyGrant, limits: CAPPED }),
            ).pipe(as),
          );
          record(
            who.name,
            "ws:grants.createOffer",
            yield* refusedOrAnswer(
              t.grants.createOffer({
                resource: { kind: "ai-account", aiAccountId: "ana-key" as never },
                limits: NO_CAP,
              }),
            ).pipe(as),
          );
        }
        if (who.name !== "ana" && who.name !== "adam") {
          record(
            who.name,
            "ws:grants.end",
            yield* refusedOrAnswer(t.grants.end({ grantId: t.acmeKeyGrant })).pipe(as),
          );
        }
        if (who.name !== "owner") {
          record(
            who.name,
            "ws:grants.dismissMigrationReview",
            yield* refusedOrAnswer(
              t.grants.dismissMigrationReview({
                aiAccountId: "ana-key" as never,
                userId: t.mia.id,
                spaceId: t.acmeId,
              }),
            ).pipe(as),
          );
        }
        // HTTP: giving Ana's account, accepting Globex's waiting loan.
        const give = yield* t.server.request("/api/grants/give", {
          cookie: who.cookie,
          body: {
            resource: { kind: "ai-account", aiAccountId: "ana-key" },
            spaceId: t.globexId,
            limits: NO_CAP,
          },
        });
        record(who.name, "http:grants.give", give.body);
        if (who.name !== "ana") assert.notEqual(give.status, 200, `${who.name} gave Ana's account`);
        if (who.name !== "gus") {
          const accept = yield* t.server.request("/api/grants/accept", {
            cookie: who.cookie,
            body: { grantId: t.globexPending },
          });
          record(who.name, "http:grants.accept", accept.body);
          assert.notEqual(accept.status, 200, `${who.name} accepted Globex's loan`);
        }
        const after = [
          yield* stateOf(t, t.acmeKeyGrant),
          yield* stateOf(t, t.globexPending),
        ].join();
        assert.equal(after, before, `${who.name} changed a loan not theirs`);
      }
      // `claim-offer` over HTTP: whoever holds the link applies it to a Space they decide for.
      swept.add("http:grants.claimOffer");

      // What each one sees: Ana her loans; Acme's people the active ones there, not its Guest;
      // Globex's Admin its waiting one; the Owner, in neither, nothing.
      const anasLoans = [t.acmeKeyGrant, t.globexPending, t.acmeGroupGrant];
      assert.includeMembers([...(listedGiven.get("ana") ?? [])], anasLoans);
      for (const who of ["owner", "adam", "mia", "linus", "gus", "gina", "otto"]) {
        assert.deepEqual(listedGiven.get(who), [], `${who}'s given loans`);
      }
      assert.sameMembers(
        [...(listedReceived.get("adam") ?? [])],
        [t.acmeKeyGrant, t.acmeGroupGrant],
      );
      assert.sameMembers(
        [...(listedReceived.get("mia") ?? [])],
        [t.acmeKeyGrant, t.acmeGroupGrant],
      );
      assert.deepEqual(listedReceived.get("gus"), [t.globexPending]);
      for (const who of ["owner", "linus", "gina", "otto", "ana"]) {
        assert.deepEqual(listedReceived.get(who), [], `${who}'s received loans`);
      }
      // A lent group's use: its lender and whoever runs Acme.
      assert.deepEqual(
        [...vaultUse.entries()].filter(([, ok]) => ok).map(([who]) => who),
        ["adam", "ana"],
      );
      // No answer holds the Secret's value, the link's token or its hash.
      const leaks = answers.flatMap(({ who, door, text }) =>
        [SECRET, token, tokenHash]
          .filter((needle) => text.includes(needle))
          .map(() => `${who} ${door}`),
      );
      assert.deepEqual(leaks, []);

      // Every door about Grants is called here, or in the file named for it.
      const doors = [
        ...[...WsRpcGroup.requests.keys()].map((tag) => `ws:${tag}`),
        ...Object.keys(HTTP_ENDPOINT_RULES).map((name) => `http:${name}`),
        ...Object.keys(RAW_ROUTE_RULES).map((name) => `raw:${name}`),
        ...Object.keys(MCP_TOOL_RULES).map((name) => `mcp:${name}`),
      ].filter((door) => RE_GRANTS.test(door));
      assert.deepEqual(
        doors.filter((door) => !swept.has(door) && !Object.hasOwn(SWEPT_ELSEWHERE, door)).sort(),
        [],
      );
      // No MCP tool gives, accepts, ends or lists loans: lending is a person's decision.
      assert.deepEqual(
        doors.filter((door) => door.startsWith("mcp:")),
        [],
      );
    }),
);

it.effect(
  "a lending link's token reaches no log, span or audit entry, from making to applying",
  () =>
    Effect.gen(function* () {
      const t = yield* team;
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const logged: Array<string> = [];
      const logger = Logger.make(({ message, cause }) => {
        logged.push(`${JSON.stringify(message)} ${String(cause)}`);
      });
      const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.withTracer(tracer),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
      const made = yield* traced(
        t.grants
          .createOffer({
            resource: { kind: "ai-account", aiAccountId: "ana-key-2" as never },
            limits: NO_CAP,
          })
          .pipe(CommandActor.actAs(t.ana.id)),
      );
      const token = /#token=([A-Za-z0-9_-]+)/.exec(made.path)?.[1] ?? "";
      const tokenHash = NodeCrypto.createHash("sha256").update(token).digest("hex");
      yield* traced(t.grants.readOffer({ token }).pipe(CommandActor.actAs(t.adam.id)));
      // A wrong token and a used link are logged as refusals, never with the token.
      yield* traced(
        t.grants
          .readOffer({ token: `${token.slice(0, -4)}AAAA` })
          .pipe(CommandActor.actAs(t.mia.id), Effect.ignore),
      );
      const claimed = yield* traced(
        t.grants.claimOffer({ token, spaceId: t.acmeId }).pipe(CommandActor.actAs(t.adam.id)),
      );
      assert.equal(claimed.state, "active");
      yield* traced(
        t.grants
          .claimOffer({ token, spaceId: t.acmeId })
          .pipe(CommandActor.actAs(t.adam.id), Effect.ignore),
      );
      const recorded = [
        ...spans.flatMap((span) => [span.name, ...Array.from(span.attributes.values(), String)]),
        ...logged,
      ];
      assert.include(recorded, "Grants.claimOffer");
      assert.isFalse(recorded.some((value) => value.includes(token) || value.includes(tokenHash)));
      const audit = yield* t.server.sql<{ readonly text: string }>`
      SELECT COALESCE(detail_json, '') || ' ' || COALESCE(target_name, '') AS text FROM audit_log
    `;
      assert.isFalse(
        audit.some((row) => row.text.includes(token) || row.text.includes(tokenHash)),
        "an audit entry holds the token",
      );
    }),
);

it.effect(
  "the Owner, in no Organization, uses nothing lent to one: no lent AI account, group or machine",
  () =>
    Effect.gen(function* () {
      const t = yield* team;
      const allowed = yield* Effect.service(AllowedAiAccounts.AllowedAiAccounts).pipe(
        Effect.provide(AllowedAiAccounts.layer),
        Effect.provide(t.server.services),
      );
      const reached = (userId: UserId) =>
        allowed
          .for(userId, t.acmeId)
          .pipe(Effect.map((accounts) => accounts.map((entry) => entry.id as string)));
      assert.include(yield* reached(t.mia.id), "ana-key");
      assert.notInclude(yield* reached(t.ownerId), "ana-key");
      // What the Owner lends there is still theirs to use there.
      yield* t.server.sql`
        INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, created_at,
          updated_at, owner_kind, owner_id)
        VALUES ('owner-key', 'owner-key account', 'api-key', 'claude', 1, 'ready', ${AT}, ${AT},
          'user', ${t.ownerId})
      `;
      yield* lendAiAccount(t.server.sql, {
        accountId: "owner-key",
        lender: { kind: "user", id: t.ownerId },
        spaceId: t.acmeId,
      });
      assert.include(yield* reached(t.ownerId), "owner-key");

      const effective = Context.get(t.server.services, EffectiveVaults.EffectiveVaults);
      const names = (threadId: string, actingUserId: UserId) =>
        effective
          .forThread({ threadId: threadId as never, actingUserId })
          .pipe(Effect.map((set) => set.variables.map((variable) => variable.name)));
      const miasThread = yield* threadOf(t, "thread:mia", t.mia.id, t.acmeId);
      const ownersThread = yield* threadOf(t, "thread:owner", t.ownerId, t.acmeId);
      assert.include(yield* names(miasThread, t.mia.id), "ANA_TOKEN");
      assert.notInclude(yield* names(ownersThread, t.ownerId), "ANA_TOKEN");

      // A machine lent to Acme: its Admins and Members, not the Owner from outside.
      const acme: AccessPolicy.SpaceResource = {
        id: t.acmeId,
        kind: "organization",
        personalOwnerUserId: null,
        archived: false,
        frozen: false,
      };
      const lentSandbox: AccessPolicy.EnvironmentResource = {
        kind: "environment",
        environmentKind: "sandbox",
        mode: "lent",
        ownerUserId: null,
        space: acme,
        workSpaceId: t.acmeId,
      };
      const ownerOutside: AccessPolicy.Principal = {
        userId: t.ownerId,
        isOwner: true,
        roles: new Map(),
      };
      assert.equal(AccessPolicy.decide(ownerOutside, "environment.use", lentSandbox)._tag, "Deny");
      assert.equal(
        AccessPolicy.decide(
          { ...ownerOutside, roles: new Map([[t.acmeId, "member" as const]]) },
          "environment.use",
          lentSandbox,
        )._tag,
        "Allow",
      );
      // The Hub's own Sandbox of Acme stays the Owner's to run, as before.
      assert.equal(
        AccessPolicy.decide(ownerOutside, "environment.use", { ...lentSandbox, mode: "sandbox" })
          ._tag,
        "Allow",
      );
    }),
);

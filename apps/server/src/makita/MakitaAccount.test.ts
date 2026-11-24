// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off globalDate:off - reads the sealed file and the rows as they are stored.
/**
 * Makita ticket 01: the Owner registers Makita's GitHub account with a token checked by (a fake)
 * GitHub, sealed in the Hub; nobody else reads or changes it; «Stop all Makita work». No test
 * prints a token: assertions say what failed, never the value.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import { makitaHub, type MakitaHub } from "./Makita.testkit.ts";
import { classicToken, fineGrainedToken } from "./MakitaGitHub.testkit.ts";

const BOT = { login: "makita-bot", id: 4242 } as const;
const FORBIDDEN =
  "This token can change workflows or administer repositories. Make one without those scopes.";

/** «YYYY-MM-DD HH:MM:SS UTC», as GitHub writes a token's expiry, `days` from the Hub's clock. */
const expiryIn = (days: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.map(
      (now) =>
        new Date(now + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ") + " UTC",
    ),
  );

const register = (setup: MakitaHub, token: string) =>
  setup.makitaAccount.setForSession({ token: Redacted.make(token) }).pipe(setup.asOwner);

const auditOf = (setup: MakitaHub, action: string) =>
  setup.server.sql<{ readonly detail: string; readonly actor: string | null }>`
    SELECT detail_json AS detail, actor_user_id AS actor FROM audit_log WHERE action = ${action}
    ORDER BY audit_id
  `;

const storedToken = (setup: MakitaHub) =>
  Context.get(setup.server.services, ServerSecretStore.MakitaTokenStore).get("makita");

it.live.skipIf(!posix || platform === undefined)(
  "the Owner registers a classic token, sees what it can do, and replaces it with a fine-grained one; only the hint is kept",
  () =>
    Effect.gen(function* () {
      const setup = yield* makitaHub;
      assert.isNull((yield* setup.makitaAccount.getForSession({}).pipe(setup.asOwner)).account);
      const classic = classicToken("classic-a");
      setup.github.tokens.set(classic, {
        user: BOT,
        scopes: ["public_repo", "read:org"],
        expiration: "2027-02-01 00:00:00 UTC",
      });
      const made = (yield* register(setup, classic)).account!;
      assert.deepEqual(
        {
          login: made.login,
          id: made.githubUserId,
          kind: made.tokenKind,
          scopes: made.scopes,
          expiresAt: made.expiresAt,
          status: made.status,
          warnings: made.warnings,
          paused: made.globalPausedAt,
        },
        {
          login: "makita-bot",
          id: 4242,
          kind: "classic",
          scopes: ["public_repo", "read:org"],
          expiresAt: "2027-02-01T00:00:00.000Z",
          status: "ok",
          warnings: [],
          paused: null,
        },
      );
      assert.equal(made.hint, classic.slice(-4));

      // The token is sealed in its own folder: the file never holds it in clear.
      const directory = Context.get(
        setup.server.services,
        ServerSecretStore.ServerSecretStore,
      ).directory!;
      const folder = NodePath.join(directory, "makita");
      const files = NodeFS.readdirSync(folder);
      assert.deepEqual(files, ["makita.sealed"]);
      const sealed = NodeFS.readFileSync(NodePath.join(folder, files[0]!));
      assert.isFalse(sealed.includes(Buffer.from(classic.slice(4))), "the token is in clear");

      const fine = fineGrainedToken("fine-b");
      setup.github.tokens.set(fine, { user: BOT, scopes: null });
      const replaced = (yield* register(setup, fine)).account!;
      assert.equal(replaced.tokenKind, "fine-grained");
      assert.isNull(replaced.scopes);
      assert.isNull(replaced.expiresAt);
      assert.equal(replaced.hint, fine.slice(-4));
      const now = yield* storedToken(setup);
      assert.isTrue(
        Option.isSome(now) && new TextDecoder().decode(now.value) === fine,
        "the store holds the new token",
      );

      const audit = yield* auditOf(setup, "makita.account.update");
      assert.deepEqual(
        audit.map((row) => [row.actor, JSON.parse(row.detail)]),
        [
          [
            setup.ownerId,
            {
              login: "makita-bot",
              tokenKind: "classic",
              scopes: "public_repo,read:org",
              replaced: false,
            },
          ],
          [
            setup.ownerId,
            {
              login: "makita-bot",
              tokenKind: "fine-grained",
              scopes: "fine-grained",
              replaced: true,
            },
          ],
        ],
      );
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "refuses a token that can change workflows or administer repositories, one that is not a user's PAT, and one GitHub refuses; nothing is stored",
  () =>
    Effect.gen(function* () {
      const setup = yield* makitaHub;
      const refusedWith = (token: string) =>
        register(setup, token).pipe(
          Effect.flip,
          Effect.map((error) => [error.reason, error.message] as const),
        );
      for (const [seed, scopes] of [
        ["workflow", ["repo", "workflow"]],
        ["delete", ["public_repo", "delete_repo"]],
        ["admin", ["public_repo", "admin:org"]],
        ["hook", ["repo", "admin:repo_hook"]],
      ] as const) {
        const token = classicToken(seed);
        setup.github.tokens.set(token, { user: BOT, scopes });
        assert.deepEqual(yield* refusedWith(token), ["invalid", FORBIDDEN], seed);
      }
      // An OAuth app's token, spaces, nothing: not a personal access token.
      for (const token of [["gho", "x".repeat(36)].join("_"), "two words", " "]) {
        assert.equal((yield* refusedWith(token))[0], "invalid");
      }
      // GitHub refuses it (401), or it is an organization's or a bot's.
      assert.equal((yield* refusedWith(classicToken("unknown")))[0], "invalid");
      for (const type of ["Organization", "Bot"]) {
        const token = classicToken(`type-${type}`);
        setup.github.tokens.set(token, { user: { ...BOT, type }, scopes: ["public_repo"] });
        assert.equal((yield* refusedWith(token))[0], "invalid", type);
      }
      // GitHub unreachable: never stored unchecked.
      const good = classicToken("good");
      setup.github.tokens.set(good, { user: BOT, scopes: ["public_repo"] });
      setup.github.state.down = true;
      assert.equal((yield* refusedWith(good))[0], "github");
      setup.github.state.down = false;

      assert.isNull((yield* setup.makitaAccount.getForSession({}).pipe(setup.asOwner)).account);
      assert.isTrue(Option.isNone(yield* storedToken(setup)), "a refused token was stored");
      assert.lengthOf(yield* auditOf(setup, "makita.account.update"), 0);

      // A refused replacement keeps the registered token.
      yield* register(setup, good);
      const bad = classicToken("workflow");
      assert.deepEqual(yield* refusedWith(bad), ["invalid", FORBIDDEN]);
      const kept = (yield* setup.makitaAccount.getForSession({}).pipe(setup.asOwner)).account!;
      assert.equal(kept.hint, good.slice(-4));
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "only the Owner's own session reads, changes or pauses it: not an Admin, a Member, a Guest, an agent, the shell or a one-Space session",
  () =>
    Effect.gen(function* () {
      const setup = yield* makitaHub;
      const token = classicToken("owner");
      setup.github.tokens.set(token, { user: BOT, scopes: ["public_repo"] });
      yield* register(setup, token);
      const other = classicToken("other");
      setup.github.tokens.set(other, { user: { login: "intruder", id: 7 }, scopes: ["repo"] });
      const actors = [
        CommandActor.actAs(setup.people.admin),
        CommandActor.actAs(setup.people.member),
        CommandActor.actAs(setup.people.guest),
        CommandActor.actAs(setup.people.globexMember),
        CommandActor.actAsResolved({ _tag: "User", userId: setup.ownerId, via: "agent" }),
        CommandActor.actAsResolved({
          _tag: "User",
          userId: setup.ownerId,
          spaceLimit: setup.acmeId,
        }),
        CommandActor.actAsResolved({ _tag: "Server", via: "cli" }),
        CommandActor.actAsResolved({ _tag: "ThreadOwner" }),
      ];
      for (const [index, as] of actors.entries()) {
        for (const attempt of [
          setup.makitaAccount.getForSession({}),
          setup.makitaAccount.getForSession({ check: true }),
          setup.makitaAccount.setForSession({ token: Redacted.make(other) }),
          setup.makitaAccount.pauseAllForSession,
          setup.makitaAccount.resumeAllForSession,
        ]) {
          const refused = yield* attempt.pipe(as, Effect.flip);
          assert.equal(refused.reason, "forbidden", `actor ${index}`);
        }
      }
      const account = (yield* setup.makitaAccount.getForSession({}).pipe(setup.asOwner)).account!;
      assert.equal(account.login, "makita-bot");
      assert.isNull(account.globalPausedAt);
      assert.lengthOf(yield* auditOf(setup, "makita.account.update"), 1);
      assert.lengthOf(yield* auditOf(setup, "makita.pause_all"), 0);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "«Check now» marks a token GitHub refuses as invalid and a spent rate limit as such; an expiry under 14 days warns",
  () =>
    Effect.gen(function* () {
      const setup = yield* makitaHub;
      const token = classicToken("expiring");
      setup.github.tokens.set(token, {
        user: BOT,
        scopes: ["repo"],
        expiration: yield* expiryIn(10),
      });
      const made = (yield* register(setup, token)).account!;
      assert.deepEqual(made.warnings, ["expires-soon"]);
      const check = setup.makitaAccount.getForSession({ check: true }).pipe(setup.asOwner);

      setup.github.state.rateLimited = true;
      const limited = (yield* check).account!;
      assert.equal(limited.status, "rate-limited");
      assert.include(limited.warnings, "rate-limited");
      setup.github.state.rateLimited = false;
      assert.equal((yield* check).account!.status, "ok");

      // Revoked on GitHub: the next check says so.
      setup.github.tokens.delete(token);
      const refused = (yield* check).account!;
      assert.equal(refused.status, "token-invalid");
      assert.include(refused.warnings, "token-invalid");
      // A classic token without repository scopes is told apart.
      const bare = classicToken("bare");
      setup.github.tokens.set(bare, { user: BOT, scopes: ["read:user"] });
      assert.deepEqual((yield* register(setup, bare)).account!.warnings, ["no-repo-scope"]);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "«Stop all Makita work» needs an account, holds until the Owner resumes, and is audited once per change",
  () =>
    Effect.gen(function* () {
      const setup = yield* makitaHub;
      const early = yield* setup.makitaAccount.pauseAllForSession.pipe(setup.asOwner, Effect.flip);
      assert.equal(early.reason, "invalid");
      const token = classicToken("pause");
      setup.github.tokens.set(token, { user: BOT, scopes: ["public_repo"] });
      yield* register(setup, token);

      const paused = (yield* setup.makitaAccount.pauseAllForSession.pipe(setup.asOwner)).account!;
      assert.isNotNull(paused.globalPausedAt);
      assert.equal(paused.globalPausedBy, setup.ownerId);
      assert.isNotNull(paused.globalPausedByName);
      yield* setup.makitaAccount.pauseAllForSession.pipe(setup.asOwner);
      // Replacing the token does not resume Makita.
      yield* register(setup, token);
      assert.isNotNull(
        (yield* setup.makitaAccount.getForSession({}).pipe(setup.asOwner)).account!.globalPausedAt,
      );
      const resumed = (yield* setup.makitaAccount.resumeAllForSession.pipe(setup.asOwner)).account!;
      assert.isNull(resumed.globalPausedAt);
      assert.isNull(resumed.globalPausedBy);
      yield* setup.makitaAccount.resumeAllForSession.pipe(setup.asOwner);
      assert.lengthOf(yield* auditOf(setup, "makita.pause_all"), 1);
      assert.lengthOf(yield* auditOf(setup, "makita.resume_all"), 1);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "the token reaches no column, audit row, answer, log line or span; GitHub saw it only in its header",
  () => {
    const logs: Array<string> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const logger = Logger.make((options) => {
      logs.push(
        [options.message, options.cause, options.fiber.getRef(References.CurrentLogAnnotations)]
          .map((part) => {
            try {
              return JSON.stringify(part) ?? String(part);
            } catch {
              return String(part);
            }
          })
          .join(" "),
      );
    });
    return Effect.gen(function* () {
      const setup = yield* makitaHub;
      const token = classicToken("leak-check");
      const secret = token.slice(4);
      setup.github.tokens.set(token, { user: BOT, scopes: ["public_repo"] });
      const answers = [
        yield* register(setup, token),
        yield* setup.makitaAccount.getForSession({ check: true }).pipe(setup.asOwner),
        yield* setup.makitaAccount.pauseAllForSession.pipe(setup.asOwner),
      ];
      // A refused token and an unreachable GitHub leave no trace of it either.
      const refused = classicToken("leak-refused");
      setup.github.tokens.set(refused, { user: BOT, scopes: ["workflow"] });
      const refusal = yield* register(setup, refused).pipe(Effect.flip);
      setup.github.state.down = true;
      const unreachable = yield* setup.makitaAccount
        .getForSession({ check: true })
        .pipe(setup.asOwner);
      setup.github.state.down = false;

      const stored = {
        account: yield* setup.server.sql.unsafe(`SELECT * FROM makita_account`),
        audit: yield* setup.server.sql.unsafe(`SELECT * FROM audit_log`),
      };
      for (const [where, rows] of Object.entries(stored)) {
        assert.isFalse(JSON.stringify(rows).includes(secret), `the token is in ${where}`);
        assert.isFalse(
          JSON.stringify(rows).includes(refused.slice(4)),
          `a refused one in ${where}`,
        );
      }
      for (const answer of [...answers, unreachable, refusal]) {
        assert.isFalse(JSON.stringify(answer).includes(secret), "an answer holds the token");
      }
      assert.isTrue(setup.github.requests.length >= 2);
      assert.isFalse(JSON.stringify(setup.github.requests).includes(secret));
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ].join("\n");
      assert.include(recorded, "MakitaAccount.set");
      const leaks = recorded
        .split("\n")
        .filter((line) => line.includes(secret) || line.includes(refused.slice(4)))
        .map((line) => line.replaceAll(secret, "<TOKEN>").slice(0, 600));
      assert.deepEqual(leaks, [], "the token was logged or traced");
    }).pipe(
      Effect.scoped,
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);

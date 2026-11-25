// @effect-diagnostics nodeBuiltinImport:off -- random link codes and their SHA-256, small and synchronous.
/**
 * Linked GitHub accounts (Makita ticket 08): a User proves a GitHub account is theirs by posting,
 * from it, a one-time code bound to its numeric id, which Makita's intake reads. The only file
 * naming `github_identities` and `github_link_codes`; a User reads only their own link.
 */
import * as NodeCrypto from "node:crypto";

import {
  type GitHubIdentityUnlinkInput,
  type GitHubIdentityView,
  type GitHubLinkCode,
  type GitHubLinkCodeInput,
  MAKITA_GITHUB_HOST,
  MakitaError,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { MakitaGitHub, type MakitaGitHubError } from "./MakitaGitHub.ts";

const NOT_YOURS = "A GitHub account is linked by its own person in User settings, not by an agent.";
const NO_SUCH_LINK = "No such linked GitHub account.";
const NOT_SET_UP =
  "Makita is not set up on this Hub yet: the Owner registers its GitHub account in Platform → Makita.";
/** 32 letters and digits without look-alikes (0/O, 1/I/L, U): 8 of them are 40 bits. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Codes one User may ask for in an hour: each asks GitHub once with Makita's token. */
const CODES_PER_HOUR = 10;
const DAY_MS = 24 * HOUR_MS;

const decodeGitHubUser = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ login: Schema.String, id: Schema.Number, type: Schema.String }),
  ),
);

/** A GitHub login: letters, digits and single hyphens, up to 39. */
const validLogin = (login: string) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(login);

const newCode = () =>
  [...NodeCrypto.randomBytes(CODE_LENGTH)].map((byte) => ALPHABET[byte % 32]).join("");

const hashOf = (code: string) =>
  NodeCrypto.createHash("sha256").update(code.toUpperCase(), "utf8").digest("hex");

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/**
 * The code of a link command: the comment's first line is exactly `@<makita> link <code>`
 * (case-insensitive), or undefined.
 */
export const linkCodeOf = (body: string, makitaLogin: string) => {
  if (makitaLogin.length === 0) return undefined;
  const first = (body.split(/\r?\n/u)[0] ?? "").trim();
  const escaped = makitaLogin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^@${escaped}\\s+link\\s+([A-Za-z0-9]{${CODE_LENGTH}})$`, "iu").exec(
    first,
  );
  return match?.[1]?.toUpperCase();
};

/**
 * A link command read by the intake, inside its batch's transaction: the code must be unused,
 * unexpired and bound to the comment's author (by numeric id), and its User still active.
 * `refused` changes nothing; `taken` uses the code (the account is another User's); `linked`
 * links it, replacing the User's earlier account, audited.
 */
export const linkFromCommentWithin = Effect.fn("GitHubIdentities.linkFromCommentWithin")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly code: string;
    readonly author: { readonly id: number; readonly login: string };
    readonly repo: string;
    readonly now: number;
  },
) {
  const at = iso(input.now);
  const [code] = yield* sql<{ readonly userId: string }>`
      SELECT c.user_id AS "userId" FROM github_link_codes c
      JOIN users u ON u.user_id = c.user_id
      WHERE c.code_hash = ${hashOf(input.code)} AND c.used_at IS NULL AND c.expires_at > ${at}
        AND c.host = ${MAKITA_GITHUB_HOST} AND c.github_user_id = ${input.author.id}
        AND u.disabled_at IS NULL AND u.removed_at IS NULL
    `;
  if (code === undefined) return { outcome: "refused" } as const;
  const userId = UserId.make(code.userId);
  const [holder] = yield* sql<{ readonly userId: string }>`
      SELECT user_id AS "userId" FROM github_identities
      WHERE host = ${MAKITA_GITHUB_HOST} AND github_user_id = ${input.author.id}
    `;
  const taken = holder !== undefined && holder.userId !== userId;
  yield* sql`
      UPDATE github_link_codes SET used_at = ${at}, outcome = ${taken ? "taken" : "linked"}
      WHERE code_hash = ${hashOf(input.code)}
    `;
  if (taken) return { outcome: "taken", userId } as const;
  const write = AuditLog.write(sql);
  const [before] = yield* sql<{ readonly githubUserId: number; readonly login: string }>`
      SELECT github_user_id AS "githubUserId", login FROM github_identities WHERE user_id = ${userId}
    `;
  if (before !== undefined && before.githubUserId !== input.author.id) {
    yield* write({
      actor: AuditLog.userActor(userId),
      action: "github_identity.unlink",
      target: { kind: "user", id: userId },
      detail: { githubUserId: before.githubUserId, login: before.login, reason: "replaced" },
    });
  }
  yield* sql`
      INSERT INTO github_identities (user_id, host, github_user_id, login, linked_at)
      VALUES (${userId}, ${MAKITA_GITHUB_HOST}, ${input.author.id}, ${input.author.login}, ${at})
      ON CONFLICT (user_id) DO UPDATE SET host = excluded.host,
        github_user_id = excluded.github_user_id, login = excluded.login,
        linked_at = excluded.linked_at
    `;
  yield* write({
    actor: AuditLog.userActor(userId),
    action: "github_identity.link",
    target: { kind: "user", id: userId },
    detail: { githubUserId: input.author.id, login: input.author.login, repo: input.repo },
  });
  return { outcome: "linked", userId } as const;
});

/** The linked numeric GitHub ids of these Users (those who have one). */
export const linkedIdsOf = Effect.fn("GitHubIdentities.linkedIdsOf")(function* (
  sql: SqlClient.SqlClient,
  userIds: ReadonlyArray<string>,
) {
  if (userIds.length === 0) return new Map<string, number>();
  const rows = yield* sql<{ readonly userId: string; readonly githubUserId: number }>`
    SELECT user_id AS "userId", github_user_id AS "githubUserId" FROM github_identities
    WHERE host = ${MAKITA_GITHUB_HOST} AND ${sql.in("user_id", userIds)}
  `;
  return new Map(rows.map((row) => [row.userId, row.githubUserId]));
});

/**
 * The Hub User who linked this numeric GitHub id, if any (for ticket 11's approvers and the
 * audit's `orderedBy`). Whether that User may still act is the caller's to check.
 */
export const linkedUserOf = Effect.fn("GitHubIdentities.linkedUserOf")(function* (
  sql: SqlClient.SqlClient,
  githubUserId: number,
) {
  const [row] = yield* sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM github_identities
    WHERE host = ${MAKITA_GITHUB_HOST} AND github_user_id = ${githubUserId}
  `;
  return row === undefined ? Option.none<UserId>() : Option.some(UserId.make(row.userId));
});

/**
 * A User removed from the Hub (inside `InstallationUserService`'s transaction, through
 * `MakitaPermissions.forgetUserWithin`): their link and codes go, the link audited.
 */
export const forgetIdentityWithin = Effect.fn("GitHubIdentities.forgetIdentityWithin")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  userId: UserId,
) {
  yield* sql`DELETE FROM github_link_codes WHERE user_id = ${userId}`;
  const gone = yield* sql<{ readonly githubUserId: number; readonly login: string }>`
    DELETE FROM github_identities WHERE user_id = ${userId}
    RETURNING github_user_id AS "githubUserId", login
  `;
  for (const row of gone) {
    yield* AuditLog.write(sql)({
      actor,
      action: "github_identity.unlink",
      target: { kind: "user", id: userId },
      detail: { githubUserId: row.githubUserId, login: row.login, reason: "user-removed" },
    });
  }
});

export class GitHubIdentities extends Context.Service<
  GitHubIdentities,
  {
    /** The session's own link and the code it waits for; a person's own WS session only. */
    readonly getForSession: Effect.Effect<GitHubIdentityView, MakitaError>;
    /** A new code bound to the session's User and the GitHub account they name. */
    readonly linkCodeForSession: (
      input: GitHubLinkCodeInput,
    ) => Effect.Effect<GitHubLinkCode, MakitaError>;
    /** Unlinks the session's own account, or (the Owner) another User's. */
    readonly unlinkForSession: (
      input: GitHubIdentityUnlinkInput,
    ) => Effect.Effect<GitHubIdentityView, MakitaError>;
  }
>()("t3/makita/GitHubIdentities") {}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const github = yield* MakitaGitHub;

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`GitHubIdentities: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  /** The person behind a WS session: never an agent, the Hub's shell or a one-Space session. */
  const sessionUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    if (actor._tag !== "User" || actor.via !== undefined || actor.spaceLimit !== undefined) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    return actor.userId;
  });

  const allowed = Effect.fn("GitHubIdentities.allowed")(function* (
    actorUserId: UserId,
    action: "githubIdentity.manage" | "githubIdentity.unlink",
    userId: UserId,
  ) {
    const principal = yield* spaces
      .principalOf(actorUserId)
      .pipe(Effect.catch(storage("read who you are")));
    return AccessPolicy.isAllowed(
      AccessPolicy.decide(principal, action, { kind: "github-identity", userId }),
    );
  });

  const makitaLogin = sql<{ readonly login: string }>`
    SELECT login FROM makita_account WHERE account_id = 'makita'
  `.pipe(
    Effect.map((rows) => rows[0]?.login ?? null),
    Effect.catch(storage("read Makita's account")),
  );

  const viewOf = Effect.fn("GitHubIdentities.viewOf")(function* (userId: UserId) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const [linked] = yield* sql<{
      readonly githubUserId: number;
      readonly login: string;
      readonly linkedAt: string;
    }>`
      SELECT github_user_id AS "githubUserId", login, linked_at AS "linkedAt"
      FROM github_identities WHERE user_id = ${userId}
    `.pipe(Effect.catch(storage("read your GitHub account")));
    const [newest] = yield* sql<{
      readonly login: string;
      readonly createdAt: string;
      readonly expiresAt: string;
      readonly outcome: string | null;
    }>`
      SELECT login, created_at AS "createdAt", expires_at AS "expiresAt", outcome
      FROM github_link_codes WHERE user_id = ${userId}
      ORDER BY created_at DESC, code_hash LIMIT 1
    `.pipe(Effect.catch(storage("read your GitHub account")));
    const pending =
      newest === undefined ||
      newest.outcome === "linked" ||
      (linked !== undefined && newest.createdAt <= linked.linkedAt)
        ? null
        : {
            login: newest.login,
            expiresAt: newest.expiresAt,
            state:
              newest.outcome === "taken"
                ? ("taken" as const)
                : newest.expiresAt > iso(now)
                  ? ("waiting" as const)
                  : ("expired" as const),
          };
    return {
      linked: linked ?? null,
      pending,
      makitaLogin: yield* makitaLogin,
    } satisfies GitHubIdentityView;
  });

  const getForSession = Effect.gen(function* () {
    const userId = yield* sessionUser;
    if (!(yield* allowed(userId, "githubIdentity.manage", userId))) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    return yield* viewOf(userId);
  }).pipe(Effect.withSpan("GitHubIdentities.getAsSession"));

  /** The GitHub account a login names now, with Makita's token: a person's, not Makita's own. */
  const resolveLogin = Effect.fn("GitHubIdentities.resolveLogin")(function* (login: string) {
    const answer = yield* github
      .rest({ operation: "resolve-login", path: `users/${encodeURIComponent(login)}` })
      .pipe(
        Effect.catch((error: MakitaGitHubError) =>
          error.reason === "not-found"
            ? fail("invalid", `There is no GitHub user «${login}».`)
            : error.reason === "no-token"
              ? fail("invalid", NOT_SET_UP)
              : fail("github", `Could not look up «${login}» on GitHub: ${error.message}`),
        ),
      );
    const user = decodeGitHubUser(answer.body);
    if (Option.isNone(user)) {
      return yield* fail("github", `GitHub answered something unexpected for «${login}».`);
    }
    if (user.value.type !== "User") {
      return yield* fail("invalid", `«${user.value.login}» is not a person's account.`);
    }
    return user.value;
  });

  const linkCodeForSession = Effect.fn("GitHubIdentities.linkCodeAsSession")(function* (
    input: GitHubLinkCodeInput,
  ) {
    const userId = yield* sessionUser;
    if (!(yield* allowed(userId, "githubIdentity.manage", userId))) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    const login = input.login.trim().replace(/^@/u, "");
    if (!validLogin(login)) return yield* fail("invalid", `«${login}» is not a GitHub login.`);
    const [account] = yield* sql<{ readonly login: string; readonly githubUserId: number }>`
      SELECT login, github_user_id AS "githubUserId" FROM makita_account
      WHERE account_id = 'makita'
    `.pipe(Effect.catch(storage("read Makita's account")));
    if (account === undefined) return yield* fail("invalid", NOT_SET_UP);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const [recent] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM github_link_codes
      WHERE user_id = ${userId} AND created_at >= ${iso(now - HOUR_MS)}
    `.pipe(Effect.catch(storage("count your codes")));
    if ((recent?.n ?? 0) >= CODES_PER_HOUR) {
      return yield* fail(
        "limit",
        `You asked for ${CODES_PER_HOUR} codes in the last hour. Try again later.`,
      );
    }
    const user = yield* resolveLogin(login);
    if (user.id === account.githubUserId) {
      return yield* fail("invalid", "That is Makita's own GitHub account.");
    }
    const code = newCode();
    const expiresAt = iso(now + CODE_TTL_MS);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM github_link_codes WHERE expires_at < ${iso(now - DAY_MS)}`;
          // One live code per User: a new one ends the earlier ones.
          yield* sql`
            UPDATE github_link_codes SET expires_at = ${iso(now)}
            WHERE user_id = ${userId} AND used_at IS NULL AND expires_at > ${iso(now)}
          `;
          yield* sql`
            INSERT INTO github_link_codes (code_hash, user_id, host, github_user_id, login,
              created_at, expires_at)
            VALUES (${hashOf(code)}, ${userId}, ${MAKITA_GITHUB_HOST}, ${user.id}, ${user.login},
              ${iso(now)}, ${expiresAt})
          `;
        }),
      )
      .pipe(Effect.catch(storage("make a code")));
    return {
      code,
      login: user.login,
      expiresAt,
      makitaLogin: account.login,
      comment: `@${account.login} link ${code}`,
    } satisfies GitHubLinkCode;
  });

  const unlinkForSession = Effect.fn("GitHubIdentities.unlinkAsSession")(function* (
    input: GitHubIdentityUnlinkInput,
  ) {
    const actorUserId = yield* sessionUser;
    const userId = input.userId ?? actorUserId;
    if (!(yield* allowed(actorUserId, "githubIdentity.unlink", userId))) {
      // Another User's link answers like a missing one.
      return yield* fail("not-found", NO_SUCH_LINK);
    }
    const at = iso(DateTime.toEpochMillis(yield* DateTime.now));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // A code still waiting would link again: it ends with the link.
          yield* sql`
            UPDATE github_link_codes SET expires_at = ${at}
            WHERE user_id = ${userId} AND used_at IS NULL AND expires_at > ${at}
          `;
          const gone = yield* sql<{ readonly githubUserId: number; readonly login: string }>`
            DELETE FROM github_identities WHERE user_id = ${userId}
            RETURNING github_user_id AS "githubUserId", login
          `;
          for (const row of gone) {
            yield* AuditLog.write(sql)({
              actor: AuditLog.userActor(actorUserId),
              action: "github_identity.unlink",
              target: { kind: "user", id: userId },
              detail: {
                githubUserId: row.githubUserId,
                login: row.login,
                reason: userId === actorUserId ? "user" : "owner",
              },
            });
          }
        }),
      )
      .pipe(Effect.catch(storage("unlink the GitHub account")));
    return yield* viewOf(actorUserId);
  });

  return GitHubIdentities.of({ getForSession, linkCodeForSession, unlinkForSession });
});

/** Over the Hub's SQL, its Users and Makita's GitHub client (a login resolved to its id). */
export const layer = Layer.effect(GitHubIdentities, make);

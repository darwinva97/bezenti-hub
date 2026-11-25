/**
 * Makita's GitHub account (Makita ticket 01): the Owner registers or replaces the bot's token once
 * (checked with GitHub, sealed in `MakitaTokenStore`, never read back by any door), sees what it
 * can do and whether it works, and holds «Stop all Makita work». The writer of `makita_account`
 * (MakitaGitHub marks a refused token too). docs: spec «La cuenta de Makita».
 */
import {
  MAKITA_GITHUB_HOST,
  MAKITA_HUB_MAX_TASKS_LIMIT,
  MAKITA_TOKEN_EXPIRY_WARNING_DAYS,
  type MakitaAccountGetInput,
  type MakitaAccountGetResult,
  type MakitaAccountSetInput,
  type MakitaAccountStatus,
  type MakitaAccountView,
  type MakitaAccountWarning,
  MakitaError,
  type MakitaTaskLimitInput,
  type MakitaTokenKind,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import {
  MAKITA_TOKEN_ID,
  MakitaGitHub,
  type MakitaGitHubError,
  type MakitaTokenCheck,
} from "./MakitaGitHub.ts";
import { stopTasksWithin } from "./makitaRows.ts";

export { MakitaError };

const ACCOUNT_ID = "makita";
const DAY_MS = 86_400_000;
/** GitHub tokens are short ASCII; anything longer or with spaces is not one. */
const MAX_TOKEN_LENGTH = 512;

const NOT_YOURS =
  "Makita is set up by a person in Platform settings or Space settings, not by an agent.";
const OWNER_ONLY = "Only the Owner manages Makita's GitHub account.";
const NOT_A_PAT = "Paste a personal access token: classic (ghp_…) or fine-grained (github_pat_…).";
const FORBIDDEN_SCOPES =
  "This token can change workflows or administer repositories. Make one without those scopes.";

/** A classic token's scopes Makita refuses: workflows, deleting repositories, any `admin:`. */
const forbiddenScopes = (scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
  scopes.filter(
    (scope) => scope === "workflow" || scope === "delete_repo" || scope.startsWith("admin:"),
  );

/** The kind a token's prefix says; none for anything else (OAuth, app or installation tokens). */
const tokenKindOf = (token: string): MakitaTokenKind | null =>
  token.startsWith("ghp_") ? "classic" : token.startsWith("github_pat_") ? "fine-grained" : null;

const jsonOf = (scopes: ReadonlyArray<string>) => JSON.stringify(scopes);
const decodeScopes = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(Schema.Array(Schema.String))),
);

interface AccountRow {
  readonly host: string;
  readonly login: string;
  readonly githubUserId: number;
  readonly tokenKind: MakitaTokenKind;
  readonly hint: string;
  readonly scopesJson: string | null;
  readonly expiresAt: string | null;
  readonly status: MakitaAccountStatus;
  readonly checkedAt: string;
  readonly globalPausedAt: string | null;
  readonly globalPausedBy: string | null;
  readonly globalPausedByName: string | null;
  readonly updatedAt: string;
  /** Repositories the poller cannot read (ticket 04). */
  readonly unreachableRepos: number;
  /** Ticket 22: tasks at work at once across the Hub. */
  readonly maxTasks: number;
}

export class MakitaAccount extends Context.Service<
  MakitaAccount,
  {
    readonly get: (
      input: MakitaAccountGetInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaAccountGetResult, MakitaError>;
    readonly set: (
      input: MakitaAccountSetInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaAccountGetResult, MakitaError>;
    readonly pauseAll: (input: {
      readonly actorUserId: UserId;
    }) => Effect.Effect<MakitaAccountGetResult, MakitaError>;
    readonly resumeAll: (input: {
      readonly actorUserId: UserId;
    }) => Effect.Effect<MakitaAccountGetResult, MakitaError>;
    /** The same, for a person's own WS session only (never an agent, the shell or one Space). */
    readonly getForSession: (
      input: MakitaAccountGetInput,
    ) => Effect.Effect<MakitaAccountGetResult, MakitaError>;
    readonly setForSession: (
      input: MakitaAccountSetInput,
    ) => Effect.Effect<MakitaAccountGetResult, MakitaError>;
    readonly pauseAllForSession: Effect.Effect<MakitaAccountGetResult, MakitaError>;
    readonly resumeAllForSession: Effect.Effect<MakitaAccountGetResult, MakitaError>;
    /** Ticket 22: the Owner's ceiling on Makita tasks at work at once across the Hub. */
    readonly setTaskLimit: (
      input: MakitaTaskLimitInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaAccountGetResult, MakitaError>;
    readonly setTaskLimitForSession: (
      input: MakitaTaskLimitInput,
    ) => Effect.Effect<MakitaAccountGetResult, MakitaError>;
  }
>()("t3/makita/MakitaAccount") {}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

/** What GitHub's refusal of a token being registered means to the Owner. */
const refusedBecause = (error: MakitaGitHubError) => {
  switch (error.reason) {
    case "unauthorized":
      return fail("invalid", "GitHub refused this token. Check that you copied it whole.");
    case "rate-limited":
      return fail("github", "GitHub's rate limit is spent for now. Try again later.");
    case "unreachable":
      return fail("github", "Could not reach GitHub to check the token. Try again.");
    default:
      return fail("github", `GitHub did not accept the check of this token: ${error.message}`);
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const tokens = yield* ServerSecretStore.MakitaTokenStore;
  const github = yield* MakitaGitHub;

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaAccount: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  const ownerOnly = Effect.fn("MakitaAccount.ownerOnly")(function* (actorUserId: UserId) {
    const principal = yield* spaces
      .principalOf(actorUserId)
      .pipe(Effect.catch(storage("read who you are")));
    const decision = AccessPolicy.decide(
      principal,
      "makita.manageAccount",
      AccessPolicy.installation,
    );
    if (decision._tag === "Deny") return yield* fail("forbidden", OWNER_ONLY);
  });

  const readRow = sql<AccountRow>`
    SELECT a.host, a.login, a.github_user_id AS "githubUserId", a.token_kind AS "tokenKind",
      a.token_hint AS hint, a.scopes_json AS "scopesJson", a.token_expires_at AS "expiresAt",
      a.status, a.checked_at AS "checkedAt", a.global_paused_at AS "globalPausedAt",
      a.global_paused_by AS "globalPausedBy", u.display_name AS "globalPausedByName",
      a.updated_at AS "updatedAt", a.max_tasks AS "maxTasks",
      (SELECT COUNT(*) FROM makita_repo_cursors WHERE unreachable_since IS NOT NULL)
        AS "unreachableRepos"
    FROM makita_account a
    LEFT JOIN users u ON u.user_id = a.global_paused_by
    WHERE a.account_id = ${ACCOUNT_ID}
  `.pipe(
    Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
    Effect.catch(storage("read Makita's account")),
  );

  const viewOf = (row: AccountRow, now: DateTime.Utc): MakitaAccountView => {
    const scopes =
      row.scopesJson === null
        ? null
        : Option.getOrElse(decodeScopes(row.scopesJson), () => [] as ReadonlyArray<string>);
    const warnings: Array<MakitaAccountWarning> = [];
    if (row.status === "token-invalid") warnings.push("token-invalid");
    if (row.status === "rate-limited") warnings.push("rate-limited");
    if (row.status === "unreachable") warnings.push("unreachable");
    const expires =
      row.expiresAt === null ? Option.none<DateTime.DateTime>() : DateTime.make(row.expiresAt);
    if (Option.isSome(expires)) {
      const left = DateTime.toEpochMillis(expires.value) - DateTime.toEpochMillis(now);
      if (left <= 0) warnings.push("expired");
      else if (left < MAKITA_TOKEN_EXPIRY_WARNING_DAYS * DAY_MS) warnings.push("expires-soon");
    }
    if (
      row.tokenKind === "classic" &&
      scopes !== null &&
      !scopes.includes("repo") &&
      !scopes.includes("public_repo")
    ) {
      warnings.push("no-repo-scope");
    }
    if (row.unreachableRepos > 0) warnings.push("repo-unreachable");
    return {
      host: row.host,
      login: row.login,
      githubUserId: row.githubUserId,
      tokenKind: row.tokenKind,
      hint: row.hint,
      scopes,
      expiresAt: row.expiresAt,
      status: row.status,
      checkedAt: row.checkedAt,
      globalPausedAt: row.globalPausedAt,
      globalPausedBy: row.globalPausedBy === null ? null : UserId.make(row.globalPausedBy),
      globalPausedByName: row.globalPausedByName,
      updatedAt: row.updatedAt,
      warnings,
      maxTasks: row.maxTasks,
    };
  };

  const answer = Effect.gen(function* () {
    const row = yield* readRow;
    const now = yield* DateTime.now;
    return {
      account: Option.isNone(row) ? null : viewOf(row.value, now),
    } satisfies MakitaAccountGetResult;
  });

  /** «Check now»: GitHub again, with the stored token; the row says what it found. */
  const recheck = Effect.gen(function* () {
    const checked = yield* github.checkStored.pipe(Effect.result);
    const at = DateTime.formatIso(yield* DateTime.now);
    if (checked._tag === "Success") {
      const found: MakitaTokenCheck = checked.success;
      yield* sql`
        UPDATE makita_account SET status = 'ok', checked_at = ${at}, updated_at = ${at},
          login = ${found.login}, github_user_id = ${found.id},
          scopes_json = CASE WHEN token_kind = 'classic'
            THEN ${jsonOf(found.scopes ?? [])} ELSE NULL END,
          token_expires_at = ${found.expiresAt}
        WHERE account_id = ${ACCOUNT_ID}
      `.pipe(Effect.catch(storage("record the check")));
      return;
    }
    const status: MakitaAccountStatus | null =
      checked.failure.reason === "unauthorized"
        ? "token-invalid"
        : checked.failure.reason === "rate-limited"
          ? "rate-limited"
          : checked.failure.reason === "unreachable"
            ? "unreachable"
            : null;
    if (status === null) return;
    yield* sql`
      UPDATE makita_account SET status = ${status}, checked_at = ${at}, updated_at = ${at}
      WHERE account_id = ${ACCOUNT_ID}
    `.pipe(Effect.catch(storage("record the check")));
  });

  const get = Effect.fn("MakitaAccount.get")(function* (
    input: MakitaAccountGetInput & { readonly actorUserId: UserId },
  ) {
    yield* ownerOnly(input.actorUserId);
    if (input.check === true && Option.isSome(yield* readRow)) yield* recheck;
    return yield* answer;
  });

  /**
   * Registers or replaces the token: its kind by prefix, then GitHub's `GET /user` (a `User`, a
   * classic token without workflow, repository deletion or admin scopes). Only a checked token is
   * sealed; the row and its audit commit together after.
   */
  const set = Effect.fn("MakitaAccount.set")(function* (
    input: MakitaAccountSetInput & { readonly actorUserId: UserId },
  ) {
    yield* ownerOnly(input.actorUserId);
    const raw = Redacted.value(input.token).trim();
    if (raw.length === 0 || raw.length > MAX_TOKEN_LENGTH || /[^\x21-\x7e]/u.test(raw)) {
      return yield* fail("invalid", NOT_A_PAT);
    }
    const kind = tokenKindOf(raw);
    if (kind === null) return yield* fail("invalid", NOT_A_PAT);
    const found = yield* github
      .check(Redacted.make(raw))
      .pipe(Effect.catch((error) => refusedBecause(error)));
    if (found.type !== "User") {
      return yield* fail(
        "invalid",
        "This token is not a user account's. Makita works as a normal GitHub account: make the token on the bot's own account.",
      );
    }
    const scopes = kind === "classic" ? (found.scopes ?? []) : null;
    if (scopes !== null && forbiddenScopes(scopes).length > 0) {
      return yield* fail("invalid", FORBIDDEN_SCOPES);
    }
    yield* tokens
      .set(MAKITA_TOKEN_ID, new TextEncoder().encode(raw))
      .pipe(Effect.catch(storage("keep the token")));
    const at = DateTime.formatIso(yield* DateTime.now);
    const hint = raw.slice(-4);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existed =
            (yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM makita_account WHERE account_id = ${ACCOUNT_ID}
            `)[0]?.n === 1;
          yield* sql`
            INSERT INTO makita_account (account_id, host, login, github_user_id, token_kind,
              token_hint, scopes_json, token_expires_at, status, checked_at, created_by,
              created_at, updated_at)
            VALUES (${ACCOUNT_ID}, ${MAKITA_GITHUB_HOST}, ${found.login}, ${found.id}, ${kind},
              ${hint}, ${scopes === null ? null : jsonOf(scopes)}, ${found.expiresAt},
              'ok', ${at}, ${input.actorUserId}, ${at}, ${at})
            ON CONFLICT (account_id) DO UPDATE SET host = excluded.host, login = excluded.login,
              github_user_id = excluded.github_user_id, token_kind = excluded.token_kind,
              token_hint = excluded.token_hint, scopes_json = excluded.scopes_json,
              token_expires_at = excluded.token_expires_at, status = 'ok',
              checked_at = excluded.checked_at, updated_at = excluded.updated_at
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "makita.account.update",
            target: { kind: "makita_account", id: ACCOUNT_ID, name: found.login },
            detail: {
              login: found.login,
              tokenKind: kind,
              scopes: scopes === null ? "fine-grained" : scopes.join(","),
              replaced: existed,
            },
          });
        }),
      )
      .pipe(Effect.catch(storage("save Makita's account")));
    return yield* answer;
  });

  /** «Stop all Makita work» on or off: idempotent, audited when it changes. */
  const setPaused = Effect.fn("MakitaAccount.setPaused")(function* (
    actorUserId: UserId,
    paused: boolean,
  ) {
    yield* ownerOnly(actorUserId);
    const at = DateTime.formatIso(yield* DateTime.now);
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly login: string; readonly paused: number }>`
            SELECT login, global_paused_at IS NOT NULL AS paused FROM makita_account
            WHERE account_id = ${ACCOUNT_ID}
          `;
          const row = rows[0];
          if (row === undefined) return "none" as const;
          if ((row.paused === 1) === paused) return "unchanged" as const;
          yield* paused
            ? sql`
                UPDATE makita_account SET global_paused_at = ${at},
                  global_paused_by = ${actorUserId}, updated_at = ${at}
                WHERE account_id = ${ACCOUNT_ID}
              `
            : sql`
                UPDATE makita_account SET global_paused_at = NULL, global_paused_by = NULL,
                  updated_at = ${at}
                WHERE account_id = ${ACCOUNT_ID}
              `;
          yield* audit.record({
            actor: AuditLog.userActor(actorUserId),
            action: paused ? "makita.pause_all" : "makita.resume_all",
            target: { kind: "makita_account", id: ACCOUNT_ID, name: row.login },
            detail: {},
          });
          // Every running task stops with it (ticket 06); MakitaStops interrupts the turns.
          if (paused) {
            yield* stopTasksWithin(sql, {
              actor: AuditLog.userActor(actorUserId),
              scope: { all: true },
              reason: "makita-paused",
            });
          }
          return "changed" as const;
        }),
      )
      .pipe(Effect.catch(storage(paused ? "stop Makita" : "resume Makita")));
    if (outcome === "none") {
      return yield* fail("invalid", "Register Makita's GitHub account first.");
    }
    return yield* answer;
  });

  /** The person behind a WS session: never an agent, the Hub's shell or a one-Space session. */
  const sessionUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    if (actor._tag !== "User" || actor.via !== undefined || actor.spaceLimit !== undefined) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    return actor.userId;
  });

  /** Ticket 22: the ceiling across the Hub, 1–100; audited when it changes. */
  const setTaskLimit = Effect.fn("MakitaAccount.setTaskLimit")(function* (
    input: MakitaTaskLimitInput & { readonly actorUserId: UserId },
  ) {
    yield* ownerOnly(input.actorUserId);
    const next = input.maxTasks;
    if (!Number.isInteger(next) || next < 1 || next > MAKITA_HUB_MAX_TASKS_LIMIT) {
      return yield* fail(
        "invalid",
        `Choose from 1 to ${MAKITA_HUB_MAX_TASKS_LIMIT} tasks at once across the Hub.`,
      );
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly login: string; readonly maxTasks: number }>`
            SELECT login, max_tasks AS "maxTasks" FROM makita_account
            WHERE account_id = ${ACCOUNT_ID}
          `;
          if (row === undefined) return "none" as const;
          if (row.maxTasks === next) return "unchanged" as const;
          yield* sql`
            UPDATE makita_account SET max_tasks = ${next}, updated_at = ${at}
            WHERE account_id = ${ACCOUNT_ID}
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "makita.account.limit",
            target: { kind: "makita_account", id: ACCOUNT_ID, name: row.login },
            detail: { from: row.maxTasks, to: next },
          });
          return "changed" as const;
        }),
      )
      .pipe(Effect.catch(storage("change how many tasks run at once")));
    if (outcome === "none") {
      return yield* fail("invalid", "Register Makita's GitHub account first.");
    }
    return yield* answer;
  });

  const pauseAll = (input: { readonly actorUserId: UserId }) => setPaused(input.actorUserId, true);
  const resumeAll = (input: { readonly actorUserId: UserId }) =>
    setPaused(input.actorUserId, false);

  return MakitaAccount.of({
    get,
    set,
    pauseAll,
    resumeAll,
    getForSession: Effect.fn("MakitaAccount.getAsSession")(function* (
      input: MakitaAccountGetInput,
    ) {
      return yield* get({ ...input, actorUserId: yield* sessionUser });
    }),
    setForSession: Effect.fn("MakitaAccount.setAsSession")(function* (
      input: MakitaAccountSetInput,
    ) {
      return yield* set({ ...input, actorUserId: yield* sessionUser });
    }),
    pauseAllForSession: sessionUser.pipe(
      Effect.flatMap((actorUserId) => pauseAll({ actorUserId })),
    ),
    resumeAllForSession: sessionUser.pipe(
      Effect.flatMap((actorUserId) => resumeAll({ actorUserId })),
    ),
    setTaskLimit,
    setTaskLimitForSession: Effect.fn("MakitaAccount.setTaskLimitAsSession")(function* (
      input: MakitaTaskLimitInput,
    ) {
      return yield* setTaskLimit({ ...input, actorUserId: yield* sessionUser });
    }),
  });
});

/** Needs Makita's own GitHub client (`MakitaGitHub.layer`), provided once beside it. */
export const layer = Layer.effect(MakitaAccount, make);

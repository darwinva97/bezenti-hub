/**
 * Makita's intake (Makita ticket 04): reads, with Makita's token and conditional requests, the
 * issue events of every repository an active configuration listens to, and decides each trigger
 * once, by its natural key: who asked, whether they may, which configuration takes it. The only
 * writer of `makita_repo_cursors` and `makita_events`. Text of issues never passes through here.
 */
import {
  MAKITA_GITHUB_HOST,
  MakitaGitHubUser,
  MakitaRepos,
  MakitaTriggers,
  SpaceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { MakitaGitHub, type MakitaGitHubAnswer, type MakitaGitHubError } from "./MakitaGitHub.ts";
import { listenedProjects, type SpaceProjectRepo, spaceProjectRepos } from "./MakitaRepos.ts";
import { stopTasksWithin } from "./makitaRows.ts";

/** The one feed batch 1 reads. */
const ISSUE_EVENTS_FEED = "issue-events";
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** A repository with a trigger in the last 30 minutes is read every 30 s; others every 2 min. */
export const FAST_POLL_MS = 30 * SECOND;
export const SLOW_POLL_MS = 2 * MINUTE;
const ACTIVE_WINDOW_MS = 30 * MINUTE;
/** A repository GitHub hides (403/404) is asked again every 10 minutes. */
const UNREACHABLE_RETRY_MS = 10 * MINUTE;
/** A rate limit holds every repository at least this long. */
const RATE_LIMIT_MIN_MS = MINUTE;
/** `git remote` per Project is not run more than once a minute. */
const REPO_CACHE_MS = MINUTE;
const RETENTION_MS = 90 * 24 * 60 * MINUTE;
const PRUNE_EVERY_MS = 60 * MINUTE;

export type MakitaEventOutcome =
  | "queued"
  | "ignored-not-allowed"
  | "ignored-bot"
  | "ignored-self"
  | "ignored-paused"
  | "ignored-no-config";

/** A configuration as the intake reads it for one repository. */
export interface ListeningConfig {
  readonly configId: string;
  readonly spaceId: SpaceId;
  readonly projectId: string;
  /** Lower case. */
  readonly label: string | null;
  readonly callerIds: ReadonlySet<number>;
  /** Lower-case logins it never answers (other bots that are normal accounts). */
  readonly ignore: ReadonlySet<string>;
  /** Not paused, in an open Space. */
  readonly active: boolean;
}

/** One repository and the configurations listening to it, oldest first. */
export interface ListenedRepo {
  /** `owner/name` as the first Project's remote spells it. */
  readonly repo: string;
  readonly configs: ReadonlyArray<ListeningConfig>;
}

/** An event the intake accepted for a configuration (ticket 05 makes it a task). */
export interface QueuedEvent {
  readonly eventKey: string;
  readonly repo: string;
  readonly number: number;
  readonly configId: string;
}

const IssueEvent = Schema.Struct({
  id: Schema.Number,
  event: Schema.String,
  actor: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      id: Schema.Number,
      type: Schema.optional(Schema.String),
    }),
  ),
  label: Schema.optional(Schema.Struct({ name: Schema.String })),
  created_at: Schema.optional(Schema.String),
  issue: Schema.optional(
    Schema.Struct({
      number: Schema.Number,
      pull_request: Schema.optional(Schema.Unknown),
    }),
  ),
});
type IssueEvent = typeof IssueEvent.Type;
const decodeEvents = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const decodeEvent = Schema.decodeUnknownOption(IssueEvent);
const decodeRepos = Schema.decodeUnknownOption(Schema.fromJsonString(MakitaRepos));
const decodeTriggers = Schema.decodeUnknownOption(Schema.fromJsonString(MakitaTriggers));
const decodeUsers = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(MakitaGitHubUser)),
);
const decodeLogins = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/**
 * The decision for one `labeled` event of a repository (spec «Quién lo pide y si puede»): Makita
 * itself, bots, then the oldest active configuration whose label matches and whose list holds the
 * actor's numeric id. None when no configuration uses that label: the event is not stored.
 */
const decideLabeled = (input: {
  readonly event: IssueEvent;
  readonly listened: ListenedRepo;
  readonly makitaUserId: number;
}):
  | {
      readonly outcome: MakitaEventOutcome;
      readonly configId: string;
      readonly detail: string | null;
    }
  | undefined => {
  const { event, listened } = input;
  const label = event.label?.name.toLowerCase();
  if (event.event !== "labeled" || label === undefined || event.issue === undefined) return;
  const candidates = listened.configs.filter((config) => config.label === label);
  const oldest = candidates[0];
  if (oldest === undefined) return;
  const actor = event.actor;
  const decided = (outcome: MakitaEventOutcome, configId = oldest.configId, detail?: string) => ({
    outcome,
    configId,
    detail: detail ?? null,
  });
  if (actor === null) return decided("ignored-bot", oldest.configId, "ghost");
  if (actor.id === input.makitaUserId) return decided("ignored-self");
  const login = actor.login.toLowerCase();
  if (actor.type === "Bot" || candidates.some((config) => config.ignore.has(login))) {
    return decided("ignored-bot");
  }
  const active = candidates.filter((config) => config.active);
  const first = active[0];
  if (first === undefined) return decided("ignored-paused");
  if (event.issue.pull_request !== undefined) {
    return decided("ignored-no-config", first.configId, "pull-request");
  }
  const taker = active.find((config) => config.callerIds.has(actor.id));
  return taker === undefined
    ? decided("ignored-not-allowed", first.configId)
    : decided("queued", taker.configId);
};

export class MakitaIntake extends Context.Service<
  MakitaIntake,
  {
    /**
     * One pass: every due repository read once, its triggers decided and stored. Answers the
     * events it queued in this pass. What the Scheduler runs.
     */
    readonly pollDue: Effect.Effect<ReadonlyArray<QueuedEvent>>;
    /** The repositories listened to now, by lower-case `owner/name`. */
    readonly listened: Effect.Effect<ReadonlyMap<string, ListenedRepo>>;
  }
>()("t3/makita/MakitaIntake") {}

interface CursorRow {
  readonly repo: string;
  readonly etag: string | null;
  readonly cursor: string | null;
  readonly nextPollAt: string | null;
  readonly unreachableSince: string | null;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const millisOf = (value: string | null) => {
  if (value === null) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const github = yield* MakitaGitHub;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const processes = yield* ProcessRunner.ProcessRunner;
  /** Until when every request waits (a rate limit: one token, one quota). */
  const holdUntil = yield* Ref.make(0);
  const lastPrune = yield* Ref.make(0);
  /** Each Space's Projects and repositories, read at most once a minute. */
  const repoCache = yield* Ref.make(
    new Map<string, { readonly at: number; readonly projects: ReadonlyArray<SpaceProjectRepo> }>(),
  );

  const projectsOf = Effect.fn("MakitaIntake.projectsOf")(function* (
    spaceId: SpaceId,
    now: number,
  ) {
    const cached = (yield* Ref.get(repoCache)).get(spaceId);
    if (cached !== undefined && now - cached.at < REPO_CACHE_MS) return cached.projects;
    const projects = yield* spaceProjectRepos(sql, spaceId).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processes),
    );
    yield* Ref.update(repoCache, (current) => new Map(current).set(spaceId, { at: now, projects }));
    return projects;
  });

  /** Every live configuration's repositories; pause and Space state read fresh each pass. */
  const listenedAt = Effect.fn("MakitaIntake.listenedAt")(function* (now: number) {
    const rows = yield* sql<{
      readonly configId: string;
      readonly spaceId: string;
      readonly reposJson: string;
      readonly triggersJson: string;
      readonly callersJson: string;
      readonly ignoreJson: string;
      readonly pausedAt: string | null;
    }>`
      SELECT config_id AS "configId", space_id AS "spaceId", repos_json AS "reposJson",
        triggers_json AS "triggersJson", callers_json AS "callersJson",
        ignore_json AS "ignoreJson", paused_at AS "pausedAt"
      FROM makita_configs WHERE deleted_at IS NULL
      ORDER BY created_at, config_id
    `;
    const spaceIds = [...new Set(rows.map((row) => SpaceId.make(row.spaceId)))];
    const found = yield* spaces.spacesById(spaceIds);
    const byRepo = new Map<string, { repo: string; configs: Array<ListeningConfig> }>();
    for (const row of rows) {
      const spaceId = SpaceId.make(row.spaceId);
      const space = found.get(spaceId);
      // A deleted Space's configurations listen to nothing.
      if (space === undefined) continue;
      const repos = decodeRepos(row.reposJson);
      if (Option.isNone(repos)) continue;
      const triggers = decodeTriggers(row.triggersJson);
      const label = Option.isSome(triggers) ? (triggers.value.label?.toLowerCase() ?? null) : null;
      const callerIds = new Set(
        Option.getOrElse(decodeUsers(row.callersJson), () => []).map((user) => user.id),
      );
      const ignore = new Set(
        Option.getOrElse(decodeLogins(row.ignoreJson), () => []).map((login) =>
          login.toLowerCase(),
        ),
      );
      const active = row.pausedAt === null && !space.resource.archived && !space.resource.frozen;
      for (const project of listenedProjects(repos.value, yield* projectsOf(spaceId, now))) {
        const key = project.repo.toLowerCase();
        const entry = byRepo.get(key) ?? { repo: project.repo, configs: [] };
        // One configuration listens to a repository once, through its first Project.
        if (!entry.configs.some((config) => config.configId === row.configId)) {
          entry.configs.push({
            configId: row.configId,
            spaceId,
            projectId: project.projectId,
            label,
            callerIds,
            ignore,
            active,
          });
        }
        byRepo.set(key, entry);
      }
    }
    return byRepo as ReadonlyMap<string, ListenedRepo>;
  });

  const readCursors = sql<CursorRow>`
    SELECT repo, etag, cursor, next_poll_at AS "nextPollAt",
      unreachable_since AS "unreachableSince"
    FROM makita_repo_cursors WHERE host = ${MAKITA_GITHUB_HOST} AND feed = ${ISSUE_EVENTS_FEED}
  `;

  /** 30 s with a trigger in the last 30 minutes (or an open task, ticket 05), else 2 minutes. */
  const cadenceOf = Effect.fn("MakitaIntake.cadenceOf")(function* (repo: string, now: number) {
    const recent = yield* sql<{ readonly n: number }>`
      SELECT (SELECT COUNT(*) FROM makita_events
          WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${repo}
            AND seen_at >= ${iso(now - ACTIVE_WINDOW_MS)})
        + (SELECT COUNT(*) FROM makita_tasks
          WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${repo}
            AND state NOT IN ('done', 'stopped', 'failed')) AS n
    `;
    return (recent[0]?.n ?? 0) > 0 ? FAST_POLL_MS : SLOW_POLL_MS;
  });

  /** What GitHub asks between polls (`X-Poll-Interval`, seconds), if anything. */
  const askedInterval = (answer: MakitaGitHubAnswer) => {
    const seconds = Number(answer.headers["x-poll-interval"]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * SECOND : 0;
  };

  const saveCursor = (input: {
    readonly repo: string;
    readonly etag: string | null;
    readonly cursor: string | null;
    readonly nextPollAt: number;
  }) => sql`
    INSERT INTO makita_repo_cursors (host, repo, feed, etag, cursor, next_poll_at, last_error,
      unreachable_since)
    VALUES (${MAKITA_GITHUB_HOST}, ${input.repo}, ${ISSUE_EVENTS_FEED}, ${input.etag},
      ${input.cursor}, ${iso(input.nextPollAt)}, NULL, NULL)
    ON CONFLICT (host, repo, feed) DO UPDATE SET etag = excluded.etag, cursor = excluded.cursor,
      next_poll_at = excluded.next_poll_at, last_error = NULL, unreachable_since = NULL
  `;

  const saveFailure = (input: {
    readonly repo: string;
    readonly reason: MakitaGitHubError["reason"];
    readonly unreachable: boolean;
    readonly now: number;
    readonly nextPollAt: number;
  }) => sql`
    INSERT INTO makita_repo_cursors (host, repo, feed, next_poll_at, last_error, unreachable_since)
    VALUES (${MAKITA_GITHUB_HOST}, ${input.repo}, ${ISSUE_EVENTS_FEED}, ${iso(input.nextPollAt)},
      ${input.reason}, ${input.unreachable ? iso(input.now) : null})
    ON CONFLICT (host, repo, feed) DO UPDATE SET next_poll_at = excluded.next_poll_at,
      last_error = excluded.last_error,
      unreachable_since = CASE WHEN ${input.unreachable ? 1 : 0} = 1
        THEN COALESCE(makita_repo_cursors.unreachable_since, excluded.unreachable_since)
        ELSE makita_repo_cursors.unreachable_since END
  `;

  /**
   * One batch of a repository's new events and its cursor, in one transaction: a crash before the
   * commit re-reads the batch, one after finds every key taken.
   */
  const writeBatch = Effect.fn("MakitaIntake.writeBatch")(function* (input: {
    readonly listened: ListenedRepo;
    readonly events: ReadonlyArray<IssueEvent>;
    readonly makitaUserId: number;
    readonly etag: string | null;
    readonly cursor: string;
    readonly now: number;
    readonly nextPollAt: number;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const queued: Array<QueuedEvent> = [];
        for (const event of input.events) {
          // An issue closed or locked stops its live task; MakitaStops interrupts its turn.
          if ((event.event === "closed" || event.event === "locked") && event.issue !== undefined) {
            yield* stopTasksWithin(sql, {
              actor: { source: "system" },
              scope: {
                issue: {
                  host: MAKITA_GITHUB_HOST,
                  repo: input.listened.repo,
                  number: event.issue.number,
                },
              },
              reason: event.event === "closed" ? "issue-closed" : "issue-locked",
            });
            continue;
          }
          const decision = decideLabeled({
            event,
            listened: input.listened,
            makitaUserId: input.makitaUserId,
          });
          if (decision === undefined || event.issue === undefined) continue;
          const eventKey = `gh:issue-event:${event.id}`;
          const inserted = yield* sql<{ readonly key: string }>`
            INSERT INTO makita_events (event_key, host, repo, number, kind, actor_github_id,
              actor_login, created_at_github, seen_at, config_id, outcome, detail)
            VALUES (${eventKey}, ${MAKITA_GITHUB_HOST}, ${input.listened.repo},
              ${event.issue.number}, ${event.issue.pull_request === undefined ? "issue" : "pull"},
              ${event.actor?.id ?? null}, ${event.actor?.login ?? null},
              ${event.created_at ?? null}, ${iso(input.now)}, ${decision.configId},
              ${decision.outcome}, ${decision.detail})
            ON CONFLICT (event_key) DO NOTHING
            RETURNING event_key AS key
          `;
          if (inserted.length > 0 && decision.outcome === "queued") {
            queued.push({
              eventKey,
              repo: input.listened.repo,
              number: event.issue.number,
              configId: decision.configId,
            });
          }
        }
        yield* saveCursor({
          repo: input.listened.repo,
          etag: input.etag,
          cursor: input.cursor,
          nextPollAt: input.nextPollAt,
        });
        return queued;
      }),
    );
  });

  /** Reads one repository's feed; answers what it queued, or `stop` when nothing more may run. */
  const pollRepo = Effect.fn("MakitaIntake.pollRepo")(function* (input: {
    readonly listened: ListenedRepo;
    readonly row: CursorRow | undefined;
    readonly makitaUserId: number;
    readonly now: number;
  }) {
    const { listened, row, now } = input;
    const repo = listened.repo;
    const answer = yield* github
      .rest({
        operation: "issue-events",
        path: `repos/${repo}/issues/events?per_page=100`,
        ...(row?.etag == null ? {} : { ifNoneMatch: row.etag }),
      })
      .pipe(Effect.result);
    if (answer._tag === "Failure") {
      const error = answer.failure;
      yield* Effect.logWarning("Makita could not read a repository's issue events", {
        repo,
        reason: error.reason,
      });
      switch (error.reason) {
        case "unauthorized":
        case "no-token":
          return "stop" as const;
        case "rate-limited": {
          yield* Ref.set(holdUntil, Math.max(error.retryAt ?? 0, now + RATE_LIMIT_MIN_MS));
          return "stop" as const;
        }
        case "forbidden":
        case "not-found":
          yield* saveFailure({
            repo,
            reason: error.reason,
            unreachable: true,
            now,
            nextPollAt: now + UNREACHABLE_RETRY_MS,
          });
          return [] as ReadonlyArray<QueuedEvent>;
        default:
          yield* saveFailure({
            repo,
            reason: error.reason,
            unreachable: false,
            now,
            nextPollAt: now + SLOW_POLL_MS,
          });
          return [] as ReadonlyArray<QueuedEvent>;
      }
    }
    const etag = answer.success.headers["etag"] ?? null;
    const asked = askedInterval(answer.success);
    if (answer.success.status === 304) {
      const nextPollAt = now + Math.max(yield* cadenceOf(repo, now), asked);
      // Nothing new: no event, the cursor stays; only when to ask again.
      yield* saveCursor({ repo, etag: row?.etag ?? etag, cursor: row?.cursor ?? null, nextPollAt });
      return [] as ReadonlyArray<QueuedEvent>;
    }
    const events = Option.getOrElse(decodeEvents(answer.success.body), () => []).flatMap((raw) => {
      const decoded = decodeEvent(raw);
      return Option.isSome(decoded) ? [decoded.value] : [];
    });
    const newest = events.reduce((max, event) => Math.max(max, event.id), 0);
    const known = row?.cursor == null ? undefined : Number(row.cursor);
    if (known === undefined || !Number.isFinite(known)) {
      // Read for the first time (or again after a pause): from now on, nothing older replayed.
      const nextPollAt = now + Math.max(yield* cadenceOf(repo, now), asked);
      yield* saveCursor({ repo, etag, cursor: String(newest), nextPollAt });
      return [] as ReadonlyArray<QueuedEvent>;
    }
    const fresh = events.filter((event) => event.id > known).toSorted((a, b) => a.id - b.id);
    // A trigger in this batch counts as recent activity already.
    const triggered = fresh.some(
      (event) => decideLabeled({ event, listened, makitaUserId: input.makitaUserId }) !== undefined,
    );
    const nextPollAt =
      now + Math.max(triggered ? FAST_POLL_MS : yield* cadenceOf(repo, now), asked);
    return yield* writeBatch({
      listened,
      events: fresh,
      makitaUserId: input.makitaUserId,
      etag,
      cursor: String(Math.max(known, newest)),
      now,
      nextPollAt,
    });
  });

  const pollDue = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (now - (yield* Ref.get(lastPrune)) >= PRUNE_EVERY_MS) {
      yield* Ref.set(lastPrune, now);
      yield* sql`DELETE FROM makita_events WHERE seen_at < ${iso(now - RETENTION_MS)}`;
    }
    const [account] = yield* sql<{
      readonly githubUserId: number;
      readonly status: string;
      readonly globalPausedAt: string | null;
    }>`
      SELECT github_user_id AS "githubUserId", status, global_paused_at AS "globalPausedAt"
      FROM makita_account WHERE account_id = 'makita'
    `;
    if (account === undefined || account.globalPausedAt !== null) {
      // Nothing is read; on resume every repository starts from «now».
      yield* sql`DELETE FROM makita_repo_cursors`;
      return [] as ReadonlyArray<QueuedEvent>;
    }
    // A refused token stops the poller until the Owner replaces it (MakitaGitHub marked it).
    if (account.status === "token-invalid") return [] as ReadonlyArray<QueuedEvent>;
    if ((yield* Ref.get(holdUntil)) > now) return [] as ReadonlyArray<QueuedEvent>;
    const listened = yield* listenedAt(now);
    // A paused configuration's repositories are still read, so what comes meanwhile is
    // `ignored-paused` and never replayed. One no configuration listens to is forgotten: it
    // starts from «now» when one does.
    const repos = [...listened.values()].map((entry) => entry.repo);
    yield* repos.length === 0
      ? sql`DELETE FROM makita_repo_cursors WHERE host = ${MAKITA_GITHUB_HOST}`
      : sql`
          DELETE FROM makita_repo_cursors
          WHERE host = ${MAKITA_GITHUB_HOST} AND NOT (${sql.in("repo", repos)})
        `;
    const cursors = new Map((yield* readCursors).map((row) => [row.repo.toLowerCase(), row]));
    const queued: Array<QueuedEvent> = [];
    for (const entry of listened.values()) {
      const row = cursors.get(entry.repo.toLowerCase());
      const due = millisOf(row?.nextPollAt ?? null);
      if (due !== undefined && due > now) continue;
      const result = yield* pollRepo({
        listened: entry,
        row,
        makitaUserId: account.githubUserId,
        now,
      });
      if (result === "stop") break;
      queued.push(...result);
    }
    return queued as ReadonlyArray<QueuedEvent>;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Makita's intake could not finish a pass", { cause }).pipe(
        Effect.as([] as ReadonlyArray<QueuedEvent>),
      ),
    ),
    Effect.withSpan("MakitaIntake.pollDue"),
  );

  return MakitaIntake.of({
    pollDue,
    listened: Effect.gen(function* () {
      return yield* listenedAt(DateTime.toEpochMillis(yield* DateTime.now));
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("Makita's intake could not read its configurations", { cause }).pipe(
          Effect.as(new Map<string, ListenedRepo>() as ReadonlyMap<string, ListenedRepo>),
        ),
      ),
    ),
  });
});

/**
 * Over Makita's GitHub client, the Hub's SQL, its Spaces and a process runner (git remotes). On
 * the Scheduler with the tasks (`MakitaTasks.layerScheduled`).
 */
export const layer = Layer.effect(MakitaIntake, make);

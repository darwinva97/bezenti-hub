/**
 * Makita's intake (tickets 04, 09): reads, with Makita's token and conditional requests, the issue
 * events and comments of every listened repository, and decides each trigger once, by its natural
 * key. The only writer of `makita_repo_cursors` and `makita_events`; no text is stored.
 */
import { MAKITA_GITHUB_HOST, MakitaRepos, MakitaTriggers, SpaceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { linkCodeOf, linkFromCommentWithin } from "./GitHubIdentities.ts";
import { decideApprovalComment, isApprovalCommand, liveTaskOfItem } from "./makitaApprovers.ts";
import { allowedCallerIds } from "./makitaCallers.ts";
import { decideConversation, decodeReviewPage, reviewsPath } from "./makitaConversation.ts";
import {
  commandOf,
  type CommentCursor,
  commentOfKey,
  commentPath,
  decideComment,
  decodeCommentPage,
  FEED_PAGE,
  type FeedComment,
  formatCommentCursor,
  isAfter,
  MAKITA_FEEDS,
  MAX_FEED_PAGES,
  type MakitaFeed,
  mentions,
  parseCommentCursor,
} from "./makitaFeeds.ts";
import { MakitaGitHub, type MakitaGitHubAnswer, type MakitaGitHubError } from "./MakitaGitHub.ts";
import { listenedProjects, type SpaceProjectRepo, spaceProjectRepos } from "./MakitaRepos.ts";
import { stopTasksWithin } from "./makitaRows.ts";

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
  | "ignored-no-config"
  | "ignored-edited"
  | "command";

/** A configuration as the intake reads it for one repository. */
export interface ListeningConfig {
  readonly configId: string;
  readonly spaceId: SpaceId;
  readonly projectId: string;
  /** Lower case. */
  readonly label: string | null;
  /** Assigning an issue to Makita starts a task (ticket 09). */
  readonly assigned: boolean;
  /** Mentioning Makita starts a task (ticket 09). */
  readonly mention: boolean;
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
  assignee: Schema.optional(
    Schema.NullOr(Schema.Struct({ login: Schema.String, id: Schema.Number })),
  ),
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
const decodeLogins = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/**
 * The decision for one `labeled` or `assigned` event (spec «Quién lo pide y si puede»): Makita
 * itself, bots, then the oldest active configuration with that trigger whose list holds the actor's
 * numeric id. None when no configuration has that trigger: the event is not stored.
 */
const decideIssueEvent = (input: {
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
  if (event.issue === undefined) return;
  let candidates: ReadonlyArray<ListeningConfig>;
  let trigger: "label" | "assigned";
  if (event.event === "labeled" && event.label !== undefined) {
    const label = event.label.name.toLowerCase();
    candidates = listened.configs.filter((config) => config.label === label);
    trigger = "label";
  } else if (event.event === "assigned" && event.assignee?.id === input.makitaUserId) {
    candidates = listened.configs.filter((config) => config.assigned);
    trigger = "assigned";
  } else {
    return;
  }
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
    : decided("queued", taker.configId, trigger);
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
    /** Ticket 12: until when every request of Makita's token waits (epoch ms). */
    readonly heldUntil: Effect.Effect<number>;
    /** Ticket 12: a rate limit met elsewhere (the CI watch) holds the intake too. */
    readonly holdForRateLimit: (retryAt: number | undefined) => Effect.Effect<void>;
  }
>()("t3/makita/MakitaIntake") {}

/** Issues and pull requests whose task ended: anything else is live. */
const ENDED_STATES: ReadonlyArray<string> = ["done", "stopped", "failed"];

/** Whether a comment mentions Makita or holds a `/makita` command: only those are decided. */
const speaksToMakita = (comment: FeedComment, login: string) =>
  commandOf(comment.body) !== undefined ||
  isApprovalCommand(comment.body) ||
  mentions(comment.body, login);

/** A reaction owed to a link command once its batch commits (ticket 08). */
interface LinkReaction {
  readonly repo: string;
  readonly number: number;
  readonly eventKey: string;
  readonly userId: string;
  readonly content: "+1" | "confused";
}

interface CursorWrite {
  readonly repo: string;
  readonly feed: MakitaFeed;
  readonly etag: string | null;
  readonly cursor: string | null;
  readonly nextPollAt: number;
}

interface CursorRow {
  readonly repo: string;
  readonly feed: string;
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
  /** Ticket 14: each followed pull request's reviews ETag (a restart reads them once more). */
  const reviewEtags = new Map<string, string>();
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
      readonly createdBy: string;
      readonly callersMode: string;
      readonly callersJson: string;
      readonly ignoreJson: string;
      readonly pausedAt: string | null;
    }>`
      SELECT config_id AS "configId", space_id AS "spaceId", repos_json AS "reposJson",
        triggers_json AS "triggersJson", created_by AS "createdBy",
        callers_mode AS "callersMode", callers_json AS "callersJson",
        ignore_json AS "ignoreJson", paused_at AS "pausedAt"
      FROM makita_configs WHERE deleted_at IS NULL
      ORDER BY created_at, config_id
    `;
    // Ticket 08: whom each answers, read fresh on every pass (links and Members change).
    const allowed = yield* allowedCallerIds(sql, rows);
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
      const assigned = Option.isSome(triggers) && triggers.value.assigned;
      const mention = Option.isSome(triggers) && triggers.value.mention;
      const callerIds = allowed.get(row.configId) ?? new Set<number>();
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
            assigned,
            mention,
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
    SELECT repo, feed, etag, cursor, next_poll_at AS "nextPollAt",
      unreachable_since AS "unreachableSince"
    FROM makita_repo_cursors WHERE host = ${MAKITA_GITHUB_HOST}
  `;

  /** 30 s with a trigger in the last 30 minutes or a live task, else 2 minutes. */
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

  const saveCursor = (input: CursorWrite) => sql`
    INSERT INTO makita_repo_cursors (host, repo, feed, etag, cursor, next_poll_at, last_error,
      unreachable_since)
    VALUES (${MAKITA_GITHUB_HOST}, ${input.repo}, ${input.feed}, ${input.etag},
      ${input.cursor}, ${iso(input.nextPollAt)}, NULL, NULL)
    ON CONFLICT (host, repo, feed) DO UPDATE SET etag = excluded.etag, cursor = excluded.cursor,
      next_poll_at = excluded.next_poll_at, last_error = NULL, unreachable_since = NULL
  `;

  const saveFailure = (input: {
    readonly repo: string;
    readonly feed: MakitaFeed;
    readonly reason: MakitaGitHubError["reason"];
    readonly unreachable: boolean;
    readonly now: number;
    readonly nextPollAt: number;
  }) => sql`
    INSERT INTO makita_repo_cursors (host, repo, feed, next_poll_at, last_error, unreachable_since)
    VALUES (${MAKITA_GITHUB_HOST}, ${input.repo}, ${input.feed}, ${iso(input.nextPollAt)},
      ${input.reason}, ${input.unreachable ? iso(input.now) : null})
    ON CONFLICT (host, repo, feed) DO UPDATE SET next_poll_at = excluded.next_poll_at,
      last_error = excluded.last_error,
      unreachable_since = CASE WHEN ${input.unreachable ? 1 : 0} = 1
        THEN COALESCE(makita_repo_cursors.unreachable_since, excluded.unreachable_since)
        ELSE makita_repo_cursors.unreachable_since END
  `;

  /** One decided event, inserted once by its key; answers whether this insert took it. */
  const insertEvent = (input: {
    readonly eventKey: string;
    readonly repo: string;
    readonly number: number;
    readonly kind: "issue" | "pull";
    readonly actor: { readonly id: number; readonly login: string } | null;
    readonly createdAtGithub: string | null;
    readonly now: number;
    readonly decision: {
      readonly outcome: MakitaEventOutcome;
      /** Null for a link command (ticket 08): no Space's activity shows it. */
      readonly configId: string | null;
      readonly detail: string | null;
    };
  }) =>
    sql<{ readonly key: string }>`
      INSERT INTO makita_events (event_key, host, repo, number, kind, actor_github_id,
        actor_login, created_at_github, seen_at, config_id, outcome, detail)
      VALUES (${input.eventKey}, ${MAKITA_GITHUB_HOST}, ${input.repo}, ${input.number},
        ${input.kind}, ${input.actor?.id ?? null}, ${input.actor?.login ?? null},
        ${input.createdAtGithub}, ${iso(input.now)}, ${input.decision.configId},
        ${input.decision.outcome}, ${input.decision.detail})
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_key AS key
    `.pipe(Effect.map((rows) => rows.length > 0));

  /**
   * One batch of a feed and its cursor, in one transaction: a crash before the commit re-reads the
   * batch, one after finds every key taken.
   */
  const inBatch = <E, R>(
    cursor: CursorWrite,
    body: Effect.Effect<ReadonlyArray<QueuedEvent>, E, R>,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const queued = yield* body;
        yield* saveCursor(cursor);
        return queued;
      }),
    );

  /** Issue events: closed or locked issues stop their task; labels and assignments trigger. */
  const handleIssueEvents = Effect.fn("MakitaIntake.handleIssueEvents")(function* (input: {
    readonly listened: ListenedRepo;
    readonly events: ReadonlyArray<IssueEvent>;
    readonly makitaUserId: number;
    readonly now: number;
  }) {
    const queued: Array<QueuedEvent> = [];
    for (const event of input.events) {
      // Ticket 14: Makita's pull request merged ends its task as done (its `closed` finds none).
      if (event.event === "merged" && event.issue !== undefined) {
        yield* sql`
          UPDATE makita_tasks SET state = 'done', pending_push_json = NULL,
            updated_at = ${iso(input.now)}
          WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${input.listened.repo}
            AND pr_number = ${event.issue.number} AND state NOT IN ('done', 'stopped', 'failed')
        `;
        continue;
      }
      // An issue (or, ticket 14, Makita's pull request) closed or locked stops its live task;
      // MakitaStops interrupts its turn.
      if ((event.event === "closed" || event.event === "locked") && event.issue !== undefined) {
        const pull = event.issue.pull_request !== undefined;
        yield* stopTasksWithin(sql, {
          actor: { source: "system" },
          scope: {
            issue: {
              host: MAKITA_GITHUB_HOST,
              repo: input.listened.repo,
              number: event.issue.number,
            },
          },
          reason:
            event.event === "closed"
              ? pull
                ? "pr-closed"
                : "issue-closed"
              : pull
                ? "pr-locked"
                : "issue-locked",
        });
        continue;
      }
      const decision = decideIssueEvent({
        event,
        listened: input.listened,
        makitaUserId: input.makitaUserId,
      });
      if (decision === undefined || event.issue === undefined) continue;
      const eventKey = `gh:issue-event:${event.id}`;
      const inserted = yield* insertEvent({
        eventKey,
        repo: input.listened.repo,
        number: event.issue.number,
        kind: event.issue.pull_request === undefined ? "issue" : "pull",
        actor: event.actor,
        createdAtGithub: event.created_at ?? null,
        now: input.now,
        decision,
      });
      if (inserted && decision.outcome === "queued") {
        queued.push({
          eventKey,
          repo: input.listened.repo,
          number: event.issue.number,
          configId: decision.configId,
        });
      }
    }
    return queued as ReadonlyArray<QueuedEvent>;
  });

  /** An issue's tasks: the live one's configuration, or the newest one's when it failed. */
  const tasksOf = (repo: string, number: number) =>
    sql<{ readonly configId: string; readonly state: string }>`
      SELECT config_id AS "configId", state FROM makita_tasks
      WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${repo} AND number = ${number}
      ORDER BY created_at DESC, task_id DESC
    `.pipe(
      Effect.map((rows) => {
        const live = rows.find((row) => !ENDED_STATES.includes(row.state));
        const newest = rows[0];
        return {
          live: live?.configId ?? null,
          failed: live === undefined && newest?.state === "failed" ? newest.configId : null,
        };
      }),
    );

  /** Ticket 14: Makita's own pull requests in a repository (of live tasks) → their configuration. */
  const livePullsOf = (repo: string) =>
    sql<{ readonly pr: number; readonly configId: string }>`
      SELECT pr_number AS pr, config_id AS "configId" FROM makita_tasks
      WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${repo} AND pr_number IS NOT NULL
        AND state NOT IN ('done', 'stopped', 'failed')
    `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.pr, row.configId]))));

  /**
   * Ticket 08: `@<makita> link <code>` from a new comment by a person links its author's account
   * to the code's User (GitHubIdentities decides). Never a task; the event names no configuration.
   */
  const handleLink = Effect.fn("MakitaIntake.handleLink")(function* (input: {
    readonly repo: string;
    readonly comment: FeedComment;
    readonly code: string;
    readonly makitaId: number;
    readonly now: number;
    readonly reactions: Array<LinkReaction>;
  }) {
    const { comment } = input;
    const author = comment.author;
    const outcome: MakitaEventOutcome =
      author === null || author.type === "Bot"
        ? "ignored-bot"
        : author.id === input.makitaId
          ? "ignored-self"
          : comment.updatedAt !== comment.createdAt
            ? "ignored-edited"
            : "command";
    const inserted = yield* insertEvent({
      eventKey: comment.eventKey,
      repo: input.repo,
      number: comment.number,
      kind: comment.kind,
      actor: author,
      createdAtGithub: comment.createdAt,
      now: input.now,
      decision: { outcome, configId: null, detail: "link" },
    });
    if (!inserted || outcome !== "command" || author === null) return;
    const linked = yield* linkFromCommentWithin(sql, {
      code: input.code,
      author,
      repo: input.repo,
      now: input.now,
    });
    if (linked.outcome !== "refused") {
      input.reactions.push({
        repo: input.repo,
        number: comment.number,
        eventKey: comment.eventKey,
        userId: linked.userId,
        content: linked.outcome === "linked" ? "+1" : "confused",
      });
    }
  });

  /** After the batch commits: Makita's reaction to each link command it decided (best effort). */
  const react = Effect.fn("MakitaIntake.react")(function* (reaction: LinkReaction) {
    const ref = commentOfKey(reaction.eventKey);
    if (ref === undefined) return;
    yield* github
      .rest({
        operation: "comment-reaction",
        method: "POST",
        path: `${commentPath(reaction.repo, ref.feed, ref.id)}/reactions`,
        body: { content: reaction.content },
      })
      .pipe(
        Effect.andThen(
          AuditLog.write(sql)({
            actor: { source: "system" },
            action: "makita.github.reaction",
            target: { kind: "user", id: reaction.userId },
            detail: { repo: reaction.repo, number: reaction.number, content: reaction.content },
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Makita could not react to a link command", {
            repo: reaction.repo,
            reason: "reason" in error ? error.reason : "storage",
          }),
        ),
      );
  });

  /** Comments: mentions of Makita and `/makita` commands, each decided once (ticket 09). */
  const handleComments = Effect.fn("MakitaIntake.handleComments")(function* (input: {
    readonly listened: ListenedRepo;
    readonly comments: ReadonlyArray<FeedComment>;
    readonly makita: { readonly id: number; readonly login: string };
    readonly now: number;
    readonly reactions: Array<LinkReaction>;
  }) {
    const queued: Array<QueuedEvent> = [];
    // Ticket 14: on Makita's own pull request everything said is said to it, mention or not.
    const pulls = yield* livePullsOf(input.listened.repo);
    for (const comment of input.comments) {
      const pull = pulls.get(comment.number);
      const speaks = speaksToMakita(comment, input.makita.login);
      if (!speaks && pull === undefined) continue;
      const code = speaks ? linkCodeOf(comment.body, input.makita.login) : undefined;
      if (code !== undefined) {
        yield* handleLink({
          repo: input.listened.repo,
          comment,
          code,
          makitaId: input.makita.id,
          now: input.now,
          reactions: input.reactions,
        });
        continue;
      }
      // Ticket 11: `/makita ok` in an issue or pull request conversation, for its live task.
      const approval =
        isApprovalCommand(comment.body) && comment.eventKey.startsWith("gh:issue-comment:")
          ? decideApprovalComment({
              comment,
              configs: input.listened.configs,
              makita: input.makita,
              liveConfigId:
                (yield* liveTaskOfItem(sql, input.listened.repo, comment.number))?.configId ?? null,
            })
          : undefined;
      // Ticket 14: on Makita's own pull request, what is not an approval is conversation.
      const decision =
        approval ??
        (pull === undefined
          ? decideComment({
              comment,
              configs: input.listened.configs,
              makita: input.makita,
              tasks: yield* tasksOf(input.listened.repo, comment.number),
            })
          : decideConversation({
              comment,
              config: input.listened.configs.find((config) => config.configId === pull),
              makita: input.makita,
            }));
      if (decision === undefined) continue;
      const inserted = yield* insertEvent({
        eventKey: comment.eventKey,
        repo: input.listened.repo,
        number: comment.number,
        kind: comment.kind,
        actor: comment.author,
        createdAtGithub: comment.createdAt,
        now: input.now,
        decision,
      });
      if (inserted && decision.outcome === "queued") {
        queued.push({
          eventKey: comment.eventKey,
          repo: input.listened.repo,
          number: comment.number,
          configId: decision.configId,
        });
      }
    }
    return queued as ReadonlyArray<QueuedEvent>;
  });

  /** A read GitHub refused: marks the feed; `stop` when nothing more may run this pass. */
  const onFailure = Effect.fn("MakitaIntake.onFailure")(function* (input: {
    readonly repo: string;
    readonly feed: MakitaFeed;
    readonly error: MakitaGitHubError;
    readonly now: number;
  }) {
    const { repo, feed, error, now } = input;
    yield* Effect.logWarning("Makita could not read a repository's feed", {
      repo,
      feed,
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
          feed,
          reason: error.reason,
          unreachable: true,
          now,
          nextPollAt: now + UNREACHABLE_RETRY_MS,
        });
        return [] as ReadonlyArray<QueuedEvent>;
      default:
        yield* saveFailure({
          repo,
          feed,
          reason: error.reason,
          unreachable: false,
          now,
          nextPollAt: now + SLOW_POLL_MS,
        });
        return [] as ReadonlyArray<QueuedEvent>;
    }
  });

  const read = (operation: string, path: string, etag?: string | null) =>
    github
      .rest({ operation, path, ...(etag == null ? {} : { ifNoneMatch: etag }) })
      .pipe(Effect.result);

  /** Repeats a page read while `more` says the next page is needed, up to the page cap. */
  const nextPages = Effect.fn("MakitaIntake.nextPages")(function* <T>(input: {
    readonly operation: string;
    readonly pathOf: (page: number) => string;
    readonly first: ReadonlyArray<T>;
    readonly decode: (body: string) => {
      readonly items: ReadonlyArray<T>;
      readonly size: number;
    };
    readonly firstSize: number;
    readonly more: (items: ReadonlyArray<T>, size: number) => boolean;
  }) {
    const items = [...input.first];
    let size = input.firstSize;
    let last: ReadonlyArray<T> = input.first;
    let page = 1;
    while (page < MAX_FEED_PAGES && input.more(last, size)) {
      page += 1;
      const answer = yield* read(input.operation, input.pathOf(page));
      if (answer._tag === "Failure") return { _tag: "failed", error: answer.failure } as const;
      const decoded = input.decode(answer.success.body);
      last = decoded.items;
      size = decoded.size;
      items.push(...decoded.items);
    }
    return {
      _tag: "read",
      items: items as ReadonlyArray<T>,
      capped: page >= MAX_FEED_PAGES && input.more(last, size),
    } as const;
  });

  const decodeEventPage = (body: string) => {
    const raw = Option.getOrElse(decodeEvents(body), () => []);
    const items = raw.flatMap((entry) => {
      const decoded = decodeEvent(entry);
      return Option.isSome(decoded) ? [decoded.value] : [];
    });
    return { items, size: raw.length };
  };

  /** The issue events feed: newest first, read page by page down to the cursor (ticket 09). */
  const pollIssueEvents = Effect.fn("MakitaIntake.pollIssueEvents")(function* (input: {
    readonly listened: ListenedRepo;
    readonly row: CursorRow | undefined;
    readonly makitaUserId: number;
    readonly now: number;
  }) {
    const { listened, row, now } = input;
    const repo = listened.repo;
    const feed = "issue-events" as const;
    const pathOf = (page: number) =>
      `repos/${repo}/issues/events?per_page=${FEED_PAGE}${page > 1 ? `&page=${page}` : ""}`;
    const answer = yield* read("issue-events", pathOf(1), row?.etag);
    if (answer._tag === "Failure") {
      return yield* onFailure({ repo, feed, error: answer.failure, now });
    }
    const etag = answer.success.headers["etag"] ?? null;
    const asked = askedInterval(answer.success);
    if (answer.success.status === 304) {
      const nextPollAt = now + Math.max(yield* cadenceOf(repo, now), asked);
      // Nothing new: no event, the cursor stays; only when to ask again.
      yield* saveCursor({
        repo,
        feed,
        etag: row?.etag ?? etag,
        cursor: row?.cursor ?? null,
        nextPollAt,
      });
      return [] as ReadonlyArray<QueuedEvent>;
    }
    const first = decodeEventPage(answer.success.body);
    const known = row?.cursor == null ? undefined : Number(row.cursor);
    if (known === undefined || !Number.isFinite(known)) {
      // Read for the first time (or again after a pause): from now on, nothing older replayed.
      const newest = first.items.reduce((max, event) => Math.max(max, event.id), 0);
      const nextPollAt = now + Math.max(yield* cadenceOf(repo, now), asked);
      yield* saveCursor({ repo, feed, etag, cursor: String(newest), nextPollAt });
      return [] as ReadonlyArray<QueuedEvent>;
    }
    // More than a page since the last poll: older pages until the cursor is reached.
    const pages = yield* nextPages({
      operation: "issue-events",
      pathOf,
      first: first.items,
      firstSize: first.size,
      decode: decodeEventPage,
      more: (items, size) => size >= FEED_PAGE && items.every((event) => event.id > known),
    });
    if (pages._tag === "failed") {
      return yield* onFailure({ repo, feed, error: pages.error, now });
    }
    if (pages.capped) {
      yield* Effect.logWarning("Makita read the most pages it reads of a repository's events", {
        repo,
        feed,
      });
    }
    const byId = new Map(pages.items.map((event) => [event.id, event]));
    const fresh = [...byId.values()]
      .filter((event) => event.id > known)
      .toSorted((a, b) => a.id - b.id);
    const newest = fresh.reduce((max, event) => Math.max(max, event.id), known);
    // A trigger in this batch counts as recent activity already.
    const triggered = fresh.some(
      (event) =>
        decideIssueEvent({ event, listened, makitaUserId: input.makitaUserId }) !== undefined,
    );
    const nextPollAt =
      now + Math.max(triggered ? FAST_POLL_MS : yield* cadenceOf(repo, now), asked);
    return yield* inBatch(
      { repo, feed, etag, cursor: String(newest), nextPollAt },
      handleIssueEvents({ listened, events: fresh, makitaUserId: input.makitaUserId, now }),
    );
  });

  /**
   * A comment feed (`issue-comments`, `review-comments`): oldest change first since the cursor,
   * page by page; what the page cap leaves comes next poll, as the cursor only passes what was read.
   */
  const pollComments = Effect.fn("MakitaIntake.pollComments")(function* (input: {
    readonly listened: ListenedRepo;
    readonly feed: "issue-comments" | "review-comments";
    readonly row: CursorRow | undefined;
    readonly makita: { readonly id: number; readonly login: string };
    readonly now: number;
  }) {
    const { listened, feed, row, now } = input;
    const repo = listened.repo;
    const base = commentPath(repo, feed);
    const decode = (body: string) => {
      const page = decodeCommentPage(feed, body);
      return { items: page.comments, size: page.size };
    };
    const cursor = parseCommentCursor(row?.cursor ?? null);
    if (cursor === undefined) {
      // Read for the first time: start after the newest comment, nothing older replayed.
      const answer = yield* read(feed, `${base}?sort=updated&direction=desc&per_page=1`);
      if (answer._tag === "Failure") {
        return yield* onFailure({ repo, feed, error: answer.failure, now });
      }
      const newest = decode(answer.success.body).items[0];
      const start: CommentCursor =
        newest === undefined ? { at: "", id: 0 } : { at: newest.updatedAt, id: newest.id };
      yield* saveCursor({
        repo,
        feed,
        etag: null,
        cursor: formatCommentCursor(start),
        nextPollAt: now + Math.max(yield* cadenceOf(repo, now), askedInterval(answer.success)),
      });
      return [] as ReadonlyArray<QueuedEvent>;
    }
    const since = cursor.at === "" ? "" : `&since=${encodeURIComponent(cursor.at)}`;
    const pathOf = (page: number) =>
      `${base}?sort=updated&direction=asc&per_page=${FEED_PAGE}${since}${page > 1 ? `&page=${page}` : ""}`;
    const answer = yield* read(feed, pathOf(1), row?.etag);
    if (answer._tag === "Failure") {
      return yield* onFailure({ repo, feed, error: answer.failure, now });
    }
    const etag = answer.success.headers["etag"] ?? null;
    const asked = askedInterval(answer.success);
    if (answer.success.status === 304) {
      const nextPollAt = now + Math.max(yield* cadenceOf(repo, now), asked);
      yield* saveCursor({
        repo,
        feed,
        etag: row?.etag ?? etag,
        cursor: row?.cursor ?? null,
        nextPollAt,
      });
      return [] as ReadonlyArray<QueuedEvent>;
    }
    const first = decode(answer.success.body);
    const pages = yield* nextPages({
      operation: feed,
      pathOf,
      first: first.items,
      firstSize: first.size,
      decode,
      more: (_items, size) => size >= FEED_PAGE,
    });
    if (pages._tag === "failed") {
      return yield* onFailure({ repo, feed, error: pages.error, now });
    }
    const byKey = new Map(pages.items.map((comment) => [comment.eventKey, comment]));
    const fresh = [...byKey.values()]
      .filter((comment) => isAfter(comment, cursor))
      .toSorted((a, b) =>
        a.updatedAt === b.updatedAt ? a.id - b.id : a.updatedAt < b.updatedAt ? -1 : 1,
      );
    const last = fresh.at(-1);
    const moved = last === undefined ? cursor : { at: last.updatedAt, id: last.id };
    const triggered = fresh.some((comment) => speaksToMakita(comment, input.makita.login));
    const nextPollAt =
      now + Math.max(pages.capped || triggered ? FAST_POLL_MS : yield* cadenceOf(repo, now), asked);
    const reactions: Array<LinkReaction> = [];
    const queued = yield* inBatch(
      // Capped: the ETag of the first page would hide the rest, so none is kept.
      {
        repo,
        feed,
        etag: pages.capped ? null : etag,
        cursor: formatCommentCursor(moved),
        nextPollAt,
      },
      handleComments({ listened, comments: fresh, makita: input.makita, now, reactions }),
    );
    yield* Effect.forEach(reactions, react, { discard: true });
    return queued;
  });

  /**
   * Ticket 14: the reviews of Makita's own pull requests in a repository, read with the review
   * comments' cadence. No cursor: each review is decided once by its key, as every event.
   */
  const pollReviews = Effect.fn("MakitaIntake.pollReviews")(function* (input: {
    readonly listened: ListenedRepo;
    readonly makita: { readonly id: number; readonly login: string };
    readonly now: number;
  }) {
    const { listened, now } = input;
    const repo = listened.repo;
    const queued: Array<QueuedEvent> = [];
    /** A read GitHub refused: `stop` when nothing more may run this pass, else skip this one. */
    const refused = Effect.fn("MakitaIntake.reviewsRefused")(function* (error: MakitaGitHubError) {
      if (error.reason === "rate-limited") {
        yield* Ref.set(holdUntil, Math.max(error.retryAt ?? 0, now + RATE_LIMIT_MIN_MS));
        return "stop" as const;
      }
      if (error.reason === "unauthorized" || error.reason === "no-token") return "stop" as const;
      yield* Effect.logWarning("Makita could not read a pull request's reviews", {
        repo,
        reason: error.reason,
      });
      return "skip" as const;
    });
    for (const [pr, configId] of yield* livePullsOf(repo)) {
      const key = `${repo.toLowerCase()}#${pr}`;
      const decode = (body: string) => {
        const page = decodeReviewPage(pr, body);
        return { items: page.reviews, size: page.size };
      };
      const answer = yield* read("pull-reviews", reviewsPath(repo, pr, 1), reviewEtags.get(key));
      if (answer._tag === "Failure") {
        if ((yield* refused(answer.failure)) === "stop") return "stop" as const;
        continue;
      }
      // Nothing new since the last read.
      if (answer.success.status === 304) continue;
      const first = decode(answer.success.body);
      const pages = yield* nextPages({
        operation: "pull-reviews",
        pathOf: (page) => reviewsPath(repo, pr, page),
        first: first.items,
        firstSize: first.size,
        decode,
        more: (_items, size) => size >= FEED_PAGE,
      });
      if (pages._tag === "failed") {
        if ((yield* refused(pages.error)) === "stop") return "stop" as const;
        continue;
      }
      const config = listened.configs.find((entry) => entry.configId === configId);
      const taken = yield* sql.withTransaction(
        Effect.forEach(pages.items, (review) =>
          Effect.gen(function* () {
            const decision = decideConversation({ comment: review, config, makita: input.makita });
            if (decision === undefined) return [];
            const inserted = yield* insertEvent({
              eventKey: review.eventKey,
              repo,
              number: pr,
              kind: "pull",
              actor: review.author,
              createdAtGithub: review.createdAt,
              now,
              decision,
            });
            return inserted && decision.outcome === "queued"
              ? [{ eventKey: review.eventKey, repo, number: pr, configId: decision.configId }]
              : [];
          }),
        ),
      );
      queued.push(...taken.flat());
      // Only a one-page answer's ETag says nothing changed; later pages would hide behind it.
      const etag = answer.success.headers["etag"];
      if (etag !== undefined && first.size < FEED_PAGE) {
        reviewEtags.set(key, etag);
      } else {
        reviewEtags.delete(key);
      }
    }
    return queued as ReadonlyArray<QueuedEvent>;
  });

  const pollDue = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (now - (yield* Ref.get(lastPrune)) >= PRUNE_EVERY_MS) {
      yield* Ref.set(lastPrune, now);
      yield* sql`DELETE FROM makita_events WHERE seen_at < ${iso(now - RETENTION_MS)}`;
    }
    const [account] = yield* sql<{
      readonly githubUserId: number;
      readonly login: string;
      readonly status: string;
      readonly globalPausedAt: string | null;
    }>`
      SELECT github_user_id AS "githubUserId", login, status, global_paused_at AS "globalPausedAt"
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
    const cursors = new Map(
      (yield* readCursors).map((row) => [`${row.repo.toLowerCase()}|${row.feed}`, row]),
    );
    const makita = { id: account.githubUserId, login: account.login };
    const queued: Array<QueuedEvent> = [];
    poll: for (const entry of listened.values()) {
      for (const feed of MAKITA_FEEDS) {
        const row = cursors.get(`${entry.repo.toLowerCase()}|${feed}`);
        const due = millisOf(row?.nextPollAt ?? null);
        if (due !== undefined && due > now) continue;
        const result =
          feed === "issue-events"
            ? yield* pollIssueEvents({ listened: entry, row, makitaUserId: makita.id, now })
            : yield* pollComments({ listened: entry, feed, row, makita, now });
        if (result === "stop") break poll;
        queued.push(...result);
        // Ticket 14: the reviews of Makita's pull requests, with the review comments' cadence.
        if (feed === "review-comments") {
          const reviews = yield* pollReviews({ listened: entry, makita, now });
          if (reviews === "stop") break poll;
          queued.push(...reviews);
        }
      }
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
    heldUntil: Ref.get(holdUntil),
    holdForRateLimit: Effect.fn("MakitaIntake.holdForRateLimit")(function* (
      retryAt: number | undefined,
    ) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* Ref.update(holdUntil, (current) =>
        Math.max(current, retryAt ?? 0, now + RATE_LIMIT_MIN_MS),
      );
    }),
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

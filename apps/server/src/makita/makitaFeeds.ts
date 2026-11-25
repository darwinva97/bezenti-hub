/**
 * Makita ticket 09: the two comment feeds and what in a comment speaks to Makita (a mention of its
 * account, a `/makita` command), decided without I/O so the intake writes it inside its batch.
 * Comment text is only read here, never stored or logged.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type MakitaFeed = "issue-events" | "issue-comments" | "review-comments";
export const MAKITA_FEEDS: ReadonlyArray<MakitaFeed> = [
  "issue-events",
  "issue-comments",
  "review-comments",
];

/** A page of a feed holds at most this many items; at most this many pages are read a poll. */
export const FEED_PAGE = 100;
export const MAX_FEED_PAGES = 10;

const GitHubActor = Schema.Struct({
  login: Schema.String,
  id: Schema.Number,
  type: Schema.optional(Schema.String),
});

const RawComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.NullOr(GitHubActor),
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.optional(Schema.String),
  issue_url: Schema.optional(Schema.String),
  pull_request_url: Schema.optional(Schema.String),
});
const decodeRaw = Schema.decodeUnknownOption(RawComment);
const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** One comment of a feed, as the intake decides on it. */
export interface FeedComment {
  /** `gh:issue-comment:<id>` or `gh:review-comment:<id>`. */
  readonly eventKey: string;
  readonly id: number;
  readonly number: number;
  readonly kind: "issue" | "pull";
  readonly body: string;
  readonly author: typeof GitHubActor.Type | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The comment key of a feed: issue comments and pull request review comments. */
const commentKeyOf = (feed: "issue-comments" | "review-comments", id: number) =>
  feed === "issue-comments" ? `gh:issue-comment:${id}` : `gh:review-comment:${id}`;

/** A comment from its event key, to read it again by id (`issues/comments` or `pulls/comments`). */
export const commentOfKey = (eventKey: string) => {
  const match = /^gh:(issue|review)-comment:(\d+)$/u.exec(eventKey);
  return match === null
    ? undefined
    : {
        feed: match[1] === "issue" ? ("issue-comments" as const) : ("review-comments" as const),
        id: Number(match[2]),
      };
};

/** The REST path of one comment (or of a feed, without an id). */
export const commentPath = (
  repo: string,
  feed: "issue-comments" | "review-comments",
  id?: number,
) =>
  `repos/${repo}/${feed === "issue-comments" ? "issues" : "pulls"}/comments${id === undefined ? "" : `/${id}`}`;

const decodeComment = (
  feed: "issue-comments" | "review-comments",
  raw: unknown,
): FeedComment | undefined => {
  const decoded = decodeRaw(raw);
  if (Option.isNone(decoded)) return;
  const comment = decoded.value;
  const number =
    feed === "issue-comments"
      ? /\/issues\/(\d+)$/u.exec(comment.issue_url ?? "")?.[1]
      : /\/pulls\/(\d+)$/u.exec(comment.pull_request_url ?? "")?.[1];
  if (number === undefined) return;
  return {
    eventKey: commentKeyOf(feed, comment.id),
    id: comment.id,
    number: Number(number),
    kind:
      feed === "review-comments" || /\/pull\/\d+/u.test(comment.html_url ?? "") ? "pull" : "issue",
    body: comment.body ?? "",
    author: comment.user,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
};

/** A page of a comment feed; entries Makita cannot read are skipped. */
export const decodeCommentPage = (
  feed: "issue-comments" | "review-comments",
  body: string,
): { readonly comments: ReadonlyArray<FeedComment>; readonly size: number } => {
  const raw = Option.getOrElse(decodeList(body), () => [] as ReadonlyArray<unknown>);
  const comments = raw.flatMap((entry) => {
    const comment = decodeComment(feed, entry);
    return comment === undefined ? [] : [comment];
  });
  return { comments, size: raw.length };
};

/** One comment read again by id, or undefined when it is not one. */
export const decodeOneComment = (feed: "issue-comments" | "review-comments", body: string) => {
  const raw = Option.getOrUndefined(decodeJson(body));
  return raw === undefined ? undefined : decodeComment(feed, raw);
};

/**
 * Where a comment feed stands: the `updated_at` and id of the last comment handled. Comments
 * sharing a second are told apart by id, so none is lost or handled twice.
 */
export interface CommentCursor {
  /** Empty: the repository had no comment when Makita started listening. */
  readonly at: string;
  readonly id: number;
}

export const parseCommentCursor = (value: string | null): CommentCursor | undefined => {
  if (value === null) return;
  const [at, id] = value.split("|");
  const parsed = Number(id);
  return at === undefined || !Number.isFinite(parsed) ? undefined : { at, id: parsed };
};

export const formatCommentCursor = (cursor: CommentCursor) => `${cursor.at}|${cursor.id}`;

export const isAfter = (comment: FeedComment, cursor: CommentCursor) =>
  comment.updatedAt > cursor.at || (comment.updatedAt === cursor.at && comment.id > cursor.id);

/** Whether `body` mentions `@login` as a whole word, outside quoted (`>`) lines. */
export const mentions = (body: string, login: string) => {
  if (login.length === 0) return false;
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?:^|[^\\w/@.-])@${escaped}(?![\\w-])`, "iu");
  return body
    .split(/\r?\n/u)
    .some((line) => !line.trimStart().startsWith(">") && pattern.test(line));
};

export type MakitaCommand = "stop" | "retry";

/** A command: the comment's first line is exactly `/makita stop` or `/makita retry`. */
export const commandOf = (body: string): MakitaCommand | undefined => {
  const first = (body.split(/\r?\n/u)[0] ?? "").trim().toLowerCase();
  return first === "/makita stop" ? "stop" : first === "/makita retry" ? "retry" : undefined;
};

/** A configuration as a comment's decision reads it. */
export interface CommentDecidingConfig {
  readonly configId: string;
  readonly callerIds: ReadonlySet<number>;
  /** Lower-case logins it never answers. */
  readonly ignore: ReadonlySet<string>;
  readonly active: boolean;
  /** Whether a mention starts a task (`triggers.mention`). */
  readonly mention: boolean;
}

export type CommentOutcome =
  | "queued"
  | "ignored-not-allowed"
  | "ignored-bot"
  | "ignored-self"
  | "ignored-paused"
  | "ignored-no-config"
  | "ignored-edited"
  | "command";

export interface CommentDecision {
  readonly outcome: CommentOutcome;
  readonly configId: string;
  /** For `queued`: the trigger (`mention`, `stop`, `retry`); else why, or null. */
  readonly detail: string | null;
}

/**
 * The decision for one comment (spec «Quién lo pide y si puede», «Seguir la conversación»):
 * undefined when it says nothing to Makita, so it is not stored. With a live task on the issue its
 * configuration decides; otherwise the oldest active configuration a mention starts and whose list
 * holds the author's numeric id.
 */
export const decideComment = (input: {
  readonly comment: FeedComment;
  /** The configurations listening to this repository, oldest first. */
  readonly configs: ReadonlyArray<CommentDecidingConfig>;
  readonly makita: { readonly id: number; readonly login: string };
  /** The issue's tasks: the live one's configuration, or the newest one's if it failed. */
  readonly tasks: { readonly live: string | null; readonly failed: string | null };
}): CommentDecision | undefined => {
  const { comment, configs, tasks } = input;
  const command = commandOf(comment.body);
  const mentioned = mentions(comment.body, input.makita.login);
  if (command === undefined && !mentioned) return;
  const oldest = configs[0];
  if (oldest === undefined) return;
  const byId = (configId: string | null) =>
    configId === null ? undefined : configs.find((config) => config.configId === configId);
  let candidates: ReadonlyArray<CommentDecidingConfig>;
  let missing: string | null = null;
  const trigger = command ?? "mention";
  if (command === "stop") {
    const owner = byId(tasks.live);
    candidates = owner === undefined ? [] : [owner];
    if (owner === undefined) missing = "nothing-to-stop";
  } else if (command === "retry") {
    const owner = tasks.live === null ? byId(tasks.failed) : undefined;
    candidates = owner === undefined ? [] : [owner];
    if (owner === undefined) missing = tasks.live === null ? "nothing-to-retry" : "task-open";
  } else if (tasks.live !== null) {
    const owner = byId(tasks.live);
    candidates = owner === undefined ? [] : [owner];
    if (owner === undefined) missing = "task-open";
  } else {
    candidates = configs.filter((config) => config.mention);
    // No configuration starts on a mention here: not a trigger, not stored.
    if (candidates.length === 0) return;
  }
  const considered = candidates.length === 0 ? configs : candidates;
  const filed = considered[0] ?? oldest;
  const decided = (
    outcome: CommentOutcome,
    configId = filed.configId,
    detail: string | null = null,
  ): CommentDecision => ({ outcome, configId, detail });
  const author = comment.author;
  if (author === null) return decided("ignored-bot", filed.configId, "ghost");
  if (author.id === input.makita.id) return decided("ignored-self");
  const login = author.login.toLowerCase();
  if (author.type === "Bot" || considered.some((config) => config.ignore.has(login))) {
    return decided("ignored-bot");
  }
  // Only creation counts: an edited comment never becomes an order.
  if (comment.updatedAt !== comment.createdAt) return decided("ignored-edited");
  const active = considered.filter((config) => config.active);
  const first = active[0];
  if (first === undefined) return decided("ignored-paused");
  const taker = active.find((config) => config.callerIds.has(author.id));
  if (taker === undefined) return decided("ignored-not-allowed", first.configId);
  if (missing !== null) {
    return decided(
      missing === "task-open" ? "ignored-no-config" : "command",
      taker.configId,
      missing,
    );
  }
  return decided("queued", taker.configId, trigger);
};

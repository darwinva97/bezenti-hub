/**
 * Makita ticket 25: the `new-issues` feed (a repository's issues, newest first) and the decision
 * for each issue opened there, without I/O so the intake writes it inside its batch. An issue's
 * text is never read here; pull requests are skipped.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A trigger detail and the feed's name in `makita_repo_cursors`. */
const NEW_ISSUE = "new-issue";
export const NEW_ISSUES_FEED = "new-issues";

const RawIssue = Schema.Struct({
  id: Schema.Number,
  number: Schema.Number,
  created_at: Schema.String,
  user: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      id: Schema.Number,
      type: Schema.optional(Schema.String),
    }),
  ),
  pull_request: Schema.optional(Schema.Unknown),
});
const decodeIssue = Schema.decodeUnknownOption(RawIssue);
const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)));

/** One opened issue (or pull request) of the feed. */
export interface OpenedItem {
  readonly id: number;
  readonly number: number;
  readonly createdAt: string;
  readonly author: {
    readonly login: string;
    readonly id: number;
    readonly type?: string | undefined;
  } | null;
  readonly pull: boolean;
}

/** The feed's path: every state, newest first, so numbers above the cursor are what is new. */
export const newIssuesPath = (repo: string, perPage: number, page: number) =>
  `repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=${perPage}${page > 1 ? `&page=${page}` : ""}`;

export const decodeOpenedPage = (body: string) => {
  const raw = Option.getOrElse(decodeList(body), () => [] as ReadonlyArray<unknown>);
  const items = raw.flatMap((entry): ReadonlyArray<OpenedItem> => {
    const decoded = decodeIssue(entry);
    if (Option.isNone(decoded)) return [];
    const issue = decoded.value;
    return [
      {
        id: issue.id,
        number: issue.number,
        createdAt: issue.created_at,
        author: issue.user,
        pull: issue.pull_request !== undefined,
      },
    ];
  });
  return { items, size: raw.length };
};

/** A configuration as this decision reads it. */
export interface NewIssueConfig {
  readonly configId: string;
  readonly callerIds: ReadonlySet<number>;
  readonly ignore: ReadonlySet<string>;
  readonly active: boolean;
  /** «Every new issue» is on (ticket 25). */
  readonly newIssues: boolean;
  /** When it was switched on (Hub time); issues opened before it never count. */
  readonly newIssuesSince: string | null;
}

export type NewIssueOutcome =
  | "queued"
  | "ignored-not-allowed"
  | "ignored-bot"
  | "ignored-self"
  | "ignored-paused";

const millisOf = (iso: string | null) => {
  if (iso === null) return undefined;
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
};

/**
 * The decision for one opened item (spec «Quién lo pide y si puede»): undefined when no
 * configuration takes new issues from that moment on, or when it is a pull request (not stored).
 * Otherwise the oldest active configuration whose list holds the author's numeric id takes it.
 */
export const decideNewIssue = (input: {
  readonly item: OpenedItem;
  /** The configurations listening to this repository, oldest first. */
  readonly configs: ReadonlyArray<NewIssueConfig>;
  readonly makitaId: number;
}):
  | { readonly outcome: NewIssueOutcome; readonly configId: string; readonly detail: string }
  | undefined => {
  const { item } = input;
  if (item.pull) return;
  const opened = millisOf(item.createdAt);
  const candidates = input.configs.filter((config) => {
    if (!config.newIssues) return false;
    const since = millisOf(config.newIssuesSince);
    return since === undefined || (opened !== undefined && opened >= since);
  });
  const oldest = candidates[0];
  if (oldest === undefined) return;
  const decided = (outcome: NewIssueOutcome, configId = oldest.configId, detail = NEW_ISSUE) => ({
    outcome,
    configId,
    detail,
  });
  const author = item.author;
  if (author === null) return decided("ignored-bot", oldest.configId, "ghost");
  if (author.id === input.makitaId) return decided("ignored-self");
  const login = author.login.toLowerCase();
  if (author.type === "Bot" || candidates.some((config) => config.ignore.has(login))) {
    return decided("ignored-bot");
  }
  const active = candidates.filter((config) => config.active);
  const first = active[0];
  if (first === undefined) return decided("ignored-paused");
  const taker = active.find((config) => config.callerIds.has(author.id));
  // Strangers wait for Makita's own sandbox and «anyone» (tickets 15, 16): ignored, said only here.
  return taker === undefined
    ? decided("ignored-not-allowed", first.configId)
    : decided("queued", taker.configId);
};

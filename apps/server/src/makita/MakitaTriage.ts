// @effect-diagnostics nodeBuiltinImport:off -- an unpredictable frame tag per answer.
/**
 * Makita tickets 23 and 24: a task's agent looks around before working (`makita_search`, its own
 * repository only, with the other live Makita tasks there) and labels its own issue or pull
 * request from its configuration's list (`makita_label`). Repository and number are the task's.
 */
import * as NodeCrypto from "node:crypto";

import { MAKITA_GITHUB_HOST, MakitaError, SpaceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import { allowedCallerIds } from "./makitaCallers.ts";
import { MakitaGitHub, type MakitaGitHubError } from "./MakitaGitHub.ts";
import { MakitaIntake } from "./MakitaIntake.ts";
import { allowedLabels, labelsOf } from "./makitaLabels.ts";
import {
  closingIssues,
  type MakitaFoundItem,
  type MakitaLiveTask,
  RECENTLY_CLOSED_DAYS,
  searchQueries,
  searchResultsText,
  searchWordsOf,
} from "./makitaTriageText.ts";

const FRAME_TAG = "github-data";
const LIVE_STATES = ["awaiting-approval", "running", "waiting-ci", "waiting-reply"];
/** What a task's agent may still do: write or search on GitHub. */
const WORKING_STATES = ["running", "waiting-ci", "waiting-reply"];
/** GitHub's search quota is small and shared by every task: each searches at most this often. */
const MAX_SEARCHES_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
/** Results per search (two searches for «any»), and the text they may fill. */
const PER_SEARCH = 10;
const MAX_ANSWER_CHARS = 12 * 1024;
/** Label changes per call, and calls per task. */
const MAX_LABELS_PER_CALL = 10;
export const MAX_LABEL_CALLS = 10;

const SearchItem = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  repository_url: Schema.String,
  user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String, id: Schema.Number }))),
  pull_request: Schema.optional(
    Schema.NullOr(Schema.Struct({ merged_at: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
const decodeSearch = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ items: Schema.Array(SearchItem) })),
);
const decodeTrigger = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ label: Schema.optional(Schema.NullOr(Schema.String)) })),
);

export interface MakitaSearchInput {
  readonly query: string;
  readonly state?: "open" | "closed" | "any";
  readonly kind?: "issue" | "pull" | "any";
}

export interface MakitaSearchResult {
  readonly repo: string;
  readonly text: string;
  readonly count: number;
}

export interface MakitaLabelInput {
  readonly add?: ReadonlyArray<string>;
  readonly remove?: ReadonlyArray<string>;
  readonly on?: "issue" | "pull_request";
}

export interface MakitaLabelResult {
  readonly changed: boolean;
  readonly message: string;
  /** The labels Makita has set on its issue and pull request and not removed. */
  readonly labels: ReadonlyArray<string>;
}

export class MakitaTriage extends Context.Service<
  MakitaTriage,
  {
    /** `makita_search`: the calling Thread's task's repository, and nothing else. */
    readonly searchForThread: (
      threadId: ThreadId,
      input: MakitaSearchInput,
    ) => Effect.Effect<MakitaSearchResult, MakitaError>;
    /** `makita_label`: labels from the configuration's list on the task's issue or PR. */
    readonly labelForThread: (
      threadId: ThreadId,
      input: MakitaLabelInput,
    ) => Effect.Effect<MakitaLabelResult, MakitaError>;
  }
>()("t3/makita/MakitaTriage") {}

interface TriageTaskRow {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly repo: string;
  readonly number: number;
  readonly state: string;
  readonly prNumber: number | null;
  readonly taskLabels: string;
  readonly createdBy: string;
  readonly callersMode: string;
  readonly callersJson: string;
  readonly triggersJson: string;
  readonly labelsJson: string;
  readonly configPausedAt: string | null;
  readonly configDeletedAt: string | null;
}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));
const jsonOf = (value: unknown) => JSON.stringify(value);
/** A search item that is a pull request (GitHub sets `pull_request` only on those). */
const isPull = (item: typeof SearchItem.Type) =>
  item.pull_request !== undefined && item.pull_request !== null;

/**
 * The other live Makita tasks of a repository (ticket 23): issue, state, branch and pull request,
 * all public on GitHub; never their configuration or Space. For the first message and the search.
 */
export const liveTasksIn = Effect.fn("MakitaTriage.liveTasksIn")(function* (
  sql: SqlClient.SqlClient,
  repo: string,
  exceptTaskId: string | null,
) {
  const rows = yield* sql<MakitaLiveTask & { readonly taskId: string }>`
    SELECT task_id AS "taskId", number, state, branch, pr_number AS "prNumber"
    FROM makita_tasks
    WHERE host = ${MAKITA_GITHUB_HOST} AND lower(repo) = ${repo.toLowerCase()}
      AND ${sql.in("state", LIVE_STATES)}
    ORDER BY number
  `;
  return rows
    .filter((row) => row.taskId !== exceptTaskId)
    .map((row): MakitaLiveTask => ({
      number: row.number,
      state: row.state,
      branch: row.branch,
      prNumber: row.prNumber,
    }));
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const github = yield* MakitaGitHub;
  const intake = yield* MakitaIntake;
  const audit = yield* AuditLog.AuditLog;
  /** Ticket 23: when each task searched in the last hour (in memory; a restart forgets). */
  const searches = new Map<string, Array<number>>();

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaTriage: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );
  const githubRefusal = (what: string) => (error: MakitaGitHubError) =>
    Effect.gen(function* () {
      // One token, one quota: a rate limit here holds the intake too.
      if (error.reason === "rate-limited") yield* intake.holdForRateLimit(error.retryAt);
      return yield* fail("github", `Could not ${what} on GitHub: ${error.message}`);
    });

  /** The calling Thread's task, refused unless Makita may still work on it. */
  const taskOf = Effect.fn("MakitaTriage.taskOf")(function* (threadId: ThreadId) {
    const [task] = yield* sql<TriageTaskRow>`
      SELECT t.task_id AS "taskId", t.config_id AS "configId", t.space_id AS "spaceId", t.repo,
        t.number, t.state, t.pr_number AS "prNumber", t.labels_json AS "taskLabels",
        c.created_by AS "createdBy", c.callers_mode AS "callersMode",
        c.callers_json AS "callersJson", c.triggers_json AS "triggersJson",
        c.labels_json AS "labelsJson", c.paused_at AS "configPausedAt",
        c.deleted_at AS "configDeletedAt"
      FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
      WHERE t.thread_id = ${threadId}
    `.pipe(Effect.catch(storage("read this Thread's Makita task")));
    if (task === undefined) return yield* fail("forbidden", "This Thread is not a Makita task's.");
    const [account] = yield* sql<{ readonly id: number; readonly paused: string | null }>`
      SELECT github_user_id AS id, global_paused_at AS paused
      FROM makita_account WHERE account_id = 'makita'
    `.pipe(Effect.catch(storage("read Makita's account")));
    if (account === undefined || account.paused !== null) {
      return yield* fail("forbidden", "Makita is stopped for now.");
    }
    if (task.configPausedAt !== null || task.configDeletedAt !== null) {
      return yield* fail("forbidden", "This Makita configuration is paused.");
    }
    if (!WORKING_STATES.includes(task.state)) {
      return yield* fail("forbidden", "This Makita task has ended.");
    }
    return { task, botId: account.id };
  });

  /** Ticket 23: a search of the task's repository; the query only ever names words. */
  const searchForThread = Effect.fn("MakitaTriage.searchForThread")(function* (
    threadId: ThreadId,
    input: MakitaSearchInput,
  ) {
    const { task, botId } = yield* taskOf(threadId);
    const words = searchWordsOf(input.query);
    if (words === null) {
      return yield* fail("invalid", "Search with a few words: what the problem is about.");
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if ((yield* intake.heldUntil) > now) {
      return yield* fail(
        "github",
        "GitHub's limit for Makita is spent for now: go on without searching, or try later.",
      );
    }
    const recent = (searches.get(task.taskId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= MAX_SEARCHES_PER_HOUR) {
      return yield* fail(
        "limit",
        `This task has searched ${MAX_SEARCHES_PER_HOUR} times in the last hour; go on with what you found.`,
      );
    }
    searches.set(task.taskId, [...recent, now]);
    const closedSince = DateTime.formatIso(
      DateTime.makeUnsafe(now - RECENTLY_CLOSED_DAYS * DAY_MS),
    ).slice(0, 10);
    const queries = searchQueries({
      repo: task.repo,
      words,
      state: input.state ?? "any",
      kind: input.kind ?? "any",
      closedSince,
    });
    const own = `https://api.${MAKITA_GITHUB_HOST}/repos/${task.repo}`.toLowerCase();
    const found: Array<typeof SearchItem.Type> = [];
    for (const q of queries) {
      const answer = yield* github
        .rest({
          operation: "search-issues",
          path: `search/issues?q=${encodeURIComponent(q)}&per_page=${PER_SEARCH}`,
        })
        .pipe(Effect.catch(githubRefusal("search")));
      const items = Option.getOrElse(
        Option.map(decodeSearch(answer.body), (decoded) => decoded.items),
        () => [],
      );
      // Whatever GitHub answered, only the task's own repository is shown.
      for (const item of items) {
        if (item.repository_url.toLowerCase() !== own) continue;
        if (found.some((seen) => seen.number === item.number)) continue;
        found.push(item);
      }
    }
    const allowed =
      (yield* allowedCallerIds(sql, [task]).pipe(
        Effect.catch(storage("read whom Makita answers")),
      )).get(task.configId) ?? new Set<number>();
    const pullNumbers = found.filter(isPull).map((item) => item.number);
    const makitaPulls =
      pullNumbers.length === 0
        ? []
        : yield* sql<{ readonly prNumber: number; readonly number: number }>`
            SELECT pr_number AS "prNumber", number FROM makita_tasks
            WHERE host = ${MAKITA_GITHUB_HOST} AND lower(repo) = ${task.repo.toLowerCase()}
              AND ${sql.in("pr_number", pullNumbers)}
          `.pipe(Effect.catch(storage("read Makita's pull requests")));
    const items = found.map((item): MakitaFoundItem => {
      const pull = isPull(item);
      const makita = item.user?.id === botId;
      const taskIssue = makitaPulls.find((row) => row.prNumber === item.number)?.number;
      return {
        number: item.number,
        pull,
        state:
          item.state === "open"
            ? "open"
            : pull && (item.pull_request?.merged_at ?? null) !== null
              ? "merged"
              : "closed",
        title: item.title,
        body: item.body ?? "",
        author: {
          login: item.user?.login ?? "a deleted user",
          allowed: item.user !== undefined && item.user !== null && allowed.has(item.user.id),
          makita,
        },
        links: !pull
          ? []
          : taskIssue !== undefined
            ? [taskIssue]
            : [...closingIssues(item.body ?? "")].toSorted((a, b) => a - b),
      };
    });
    const live = yield* liveTasksIn(sql, task.repo, task.taskId).pipe(
      Effect.catch(storage("read the other Makita tasks")),
    );
    return {
      repo: task.repo,
      count: items.length,
      text: searchResultsText({
        repo: task.repo,
        words,
        items,
        live,
        frameTag: FRAME_TAG,
        frameId: NodeCrypto.randomBytes(9).toString("hex"),
        maxChars: MAX_ANSWER_CHARS,
      }),
    } satisfies MakitaSearchResult;
  });

  /** Ticket 24: labels from the configuration's list, on the task's own issue or pull request. */
  const labelForThread = Effect.fn("MakitaTriage.labelForThread")(function* (
    threadId: ThreadId,
    input: MakitaLabelInput,
  ) {
    const { task } = yield* taskOf(threadId);
    const configured = labelsOf(task.labelsJson);
    if (configured.length === 0) {
      return yield* fail("forbidden", "This Makita configuration lets Makita set no labels.");
    }
    const asked = [...(input.add ?? []), ...(input.remove ?? [])];
    if (asked.length === 0 || asked.length > MAX_LABELS_PER_CALL) {
      return yield* fail("invalid", `Name 1 to ${MAX_LABELS_PER_CALL} labels to add or remove.`);
    }
    const trigger = Option.getOrNull(
      Option.flatMap(decodeTrigger(task.triggersJson), (triggers) =>
        Option.fromNullishOr(triggers.label),
      ),
    );
    const add = allowedLabels(input.add ?? [], configured, trigger);
    const remove = allowedLabels(input.remove ?? [], configured, trigger);
    if (add._tag === "refused" || remove._tag === "refused") {
      const name = add._tag === "refused" ? add.name : remove._tag === "refused" ? remove.name : "";
      return yield* fail(
        "invalid",
        `«${name}» is not a label this configuration lets Makita set. It may set: ${configured.join(", ")}. Nothing was changed.`,
      );
    }
    if (add.labels.some((name) => remove.labels.includes(name))) {
      return yield* fail("invalid", "Add or remove a label, not both. Nothing was changed.");
    }
    const number = input.on === "pull_request" ? task.prNumber : task.number;
    if (number === null) {
      return yield* fail(
        "invalid",
        "This task has no pull request of its own yet: label the issue. Nothing was changed.",
      );
    }
    const [calls] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'makita.github.labels' AND target_kind = 'makita_task'
        AND target_id = ${task.taskId}
    `.pipe(Effect.catch(storage("count Makita's labels")));
    if ((calls?.n ?? 0) >= MAX_LABEL_CALLS) {
      return yield* fail(
        "limit",
        `Makita has changed labels ${MAX_LABEL_CALLS} times for this task; leave the rest to a person.`,
      );
    }
    if (add.labels.length > 0) {
      yield* github
        .rest({
          operation: "issue-labels-add",
          method: "POST",
          path: `repos/${task.repo}/issues/${number}/labels`,
          body: { labels: add.labels },
        })
        .pipe(Effect.catch(githubRefusal("add the labels")));
    }
    for (const name of remove.labels) {
      yield* github
        .rest({
          operation: "issue-labels-remove",
          method: "DELETE",
          path: `repos/${task.repo}/issues/${number}/labels/${encodeURIComponent(name)}`,
        })
        .pipe(
          // Already gone: what was asked holds.
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.void,
          ),
          Effect.catch(githubRefusal("remove the labels")),
        );
    }
    const kept = [
      ...labelsOf(task.taskLabels).filter((name) => !remove.labels.includes(name)),
      ...add.labels.filter((name) => !labelsOf(task.taskLabels).includes(name)),
    ];
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE makita_tasks SET labels_json = ${jsonOf(kept)}, updated_at = ${at}
      WHERE task_id = ${task.taskId}
    `.pipe(Effect.catch(storage("record the labels")));
    yield* audit
      .record({
        actor: { source: "agent", userId: UserId.make(task.createdBy) },
        action: "makita.github.labels",
        spaceId: SpaceId.make(task.spaceId),
        target: { kind: "makita_task", id: task.taskId, name: `${task.repo}#${task.number}` },
        detail: {
          space: task.spaceId,
          repo: task.repo,
          number,
          makita: task.configId,
          added: add.labels.join(","),
          removed: remove.labels.join(","),
        },
      })
      .pipe(Effect.catch(storage("audit the labels")));
    const said = [
      ...(add.labels.length === 0 ? [] : [`added ${add.labels.join(", ")}`]),
      ...(remove.labels.length === 0 ? [] : [`removed ${remove.labels.join(", ")}`]),
    ].join("; ");
    return {
      changed: true,
      message: `On ${task.repo}#${number}: ${said}.`,
      labels: kept,
    } satisfies MakitaLabelResult;
  });

  return MakitaTriage.of({ searchForThread, labelForThread });
});

/** Over Makita's GitHub client, the intake's rate-limit hold and the audit log. */
export const layer = Layer.effect(MakitaTriage, make);

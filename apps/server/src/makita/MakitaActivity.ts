/**
 * Makita activity (Makita ticket 07): what Makita does and spends, by configuration, repository,
 * task and caller. Reads for a person's own session: `makita.view` for the activity; a
 * configuration's usage only to its creator, its Space's usage readers and the Owner.
 */
import {
  type MakitaActivityConfig,
  type MakitaActivityEvent,
  type MakitaActivityInput,
  type MakitaActivityResult,
  type MakitaActivityTask,
  MakitaError,
  type MakitaThreadsResult,
  type MakitaUsage,
  type MakitaUsageBreakdownRow,
  type MakitaUsagePeriods,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as AiGatewayActivity from "../ai/AiGatewayActivity.ts";
import {
  addMakitaUsage,
  AiUsage,
  MAKITA_NO_PERIODS,
  MAKITA_NO_USAGE,
  type MakitaUsageRead,
} from "../ai/AiUsage.ts";
import { periodOf } from "../ai/GrantCaps.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { permittedIn } from "./makitaRows.ts";

const NOT_YOURS =
  "Makita's activity is read by a person in Platform settings or Space settings, not by an agent.";
const NO_SUCH_CONFIG = "No such Makita configuration.";
const NOT_IN_SPACE = "You cannot see Makita in this Space.";
const RECENT_TASKS = 30;
const RECENT_EVENTS = 50;
const MAX_LIVE = 100;
const MAX_THREADS = 500;
/** Tasks at work: what «Now» lists. */
const LIVE_STATES = ["running", "waiting-ci", "awaiting-approval"] as const;

export class MakitaActivity extends Context.Service<
  MakitaActivity,
  {
    readonly activity: (
      input: MakitaActivityInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaActivityResult, MakitaError>;
    readonly threads: (actorUserId: UserId) => Effect.Effect<MakitaThreadsResult, MakitaError>;
    readonly activityForSession: (
      input: MakitaActivityInput,
    ) => Effect.Effect<MakitaActivityResult, MakitaError>;
    readonly threadsForSession: Effect.Effect<MakitaThreadsResult, MakitaError>;
  }
>()("t3/makita/MakitaActivity") {}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

interface ConfigRow {
  readonly configId: string;
  readonly spaceId: string;
  readonly name: string;
  readonly createdBy: string;
  readonly pausedAt: string | null;
  readonly pausedReason: string | null;
}

interface TaskRow {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly threadId: string;
  readonly repo: string;
  readonly number: number;
  readonly kind: MakitaActivityTask["kind"];
  readonly state: MakitaActivityTask["state"];
  readonly callerLogin: string;
  readonly failure: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const TASK_COLUMNS = `task_id AS "taskId", config_id AS "configId", space_id AS "spaceId",
  thread_id AS "threadId", repo, number, kind, state, caller_login AS "callerLogin", failure,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const usage = yield* AiUsage;
  const gateway = yield* AiGatewayActivity.AiGatewayActivity;

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaActivity: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  /** Whether the viewer sees Makita in this Space (`makita.view`). */
  const seesMakita = Effect.fn("MakitaActivity.seesMakita")(function* (
    principal: AccessPolicy.Principal,
    space: AccessPolicy.SpaceResource,
  ) {
    const permitted = yield* permittedIn(sql, principal.userId, space.id).pipe(
      Effect.catch(storage("read who may use Makita")),
    );
    return AccessPolicy.isAllowed(
      AccessPolicy.decide(principal, "makita.view", {
        kind: "makita-space",
        space,
        permitted,
      } satisfies AccessPolicy.MakitaSpaceResource),
    );
  });

  const configsWhere = (where: ReturnType<typeof sql.and>) =>
    sql<ConfigRow>`
      SELECT config_id AS "configId", space_id AS "spaceId", name, created_by AS "createdBy",
        paused_at AS "pausedAt", paused_reason AS "pausedReason"
      FROM makita_configs WHERE ${where}
      ORDER BY space_id, created_at, config_id
    `.pipe(Effect.catch(storage("read the configurations")));

  /** Usage periods with what the gateway has not written yet added (tokens and requests). */
  const withUnwritten = Effect.fn("MakitaActivity.withUnwritten")(function* (
    periods: MakitaUsagePeriods,
    subject: string,
    starts: { readonly today: string; readonly week: string; readonly month: string },
  ) {
    let next = periods;
    for (const use of yield* gateway.unwritten(subject)) {
      const extra: MakitaUsage = { requests: use.requests, tokens: use.tokens, estimatedUsd: null };
      next = {
        today: use.day >= starts.today ? addMakitaUsage(next.today, extra) : next.today,
        week: use.day >= starts.week ? addMakitaUsage(next.week, extra) : next.week,
        month: use.day >= starts.month ? addMakitaUsage(next.month, extra) : next.month,
      };
    }
    return next;
  });

  const activity = Effect.fn("MakitaActivity.activity")(function* (
    input: MakitaActivityInput & { readonly actorUserId: UserId },
  ) {
    const principal = yield* spaces
      .principalOf(input.actorUserId)
      .pipe(Effect.catch(storage("read who you are")));
    if (principal.inactive === true) return yield* fail("forbidden", NOT_IN_SPACE);
    const owner = principal.isOwner;

    // Which configurations: one, one Space's, or (the Owner only) every Space's.
    let rows: ReadonlyArray<ConfigRow>;
    let everyone = false;
    if (input.configId !== undefined) {
      const found = yield* configsWhere(
        sql.and([sql`config_id = ${input.configId}`, sql`deleted_at IS NULL`]),
      );
      const row = found[0];
      if (row === undefined) return yield* fail("not-found", NO_SUCH_CONFIG);
      const space = (yield* spaces
        .spacesById([SpaceId.make(row.spaceId)])
        .pipe(Effect.catch(storage("read the Space")))).get(SpaceId.make(row.spaceId));
      const sees = space === undefined ? owner : yield* seesMakita(principal, space.resource);
      // Another Space's configuration answers like a missing one.
      if (!sees || (input.spaceId !== undefined && input.spaceId !== row.spaceId)) {
        return yield* fail("not-found", NO_SUCH_CONFIG);
      }
      rows = found;
    } else if (input.spaceId !== undefined) {
      const space = (yield* spaces
        .spacesById([input.spaceId])
        .pipe(Effect.catch(storage("read the Space")))).get(input.spaceId);
      if (space === undefined || !(yield* seesMakita(principal, space.resource))) {
        return yield* fail("forbidden", NOT_IN_SPACE);
      }
      rows = yield* configsWhere(
        sql.and([sql`space_id = ${input.spaceId}`, sql`deleted_at IS NULL`]),
      );
    } else {
      if (!owner)
        return yield* fail("forbidden", "Only the Owner sees every Makita configuration.");
      rows = yield* configsWhere(sql.and([sql`deleted_at IS NULL`]));
      everyone = true;
    }

    const spaceIds = [...new Set(rows.map((row) => SpaceId.make(row.spaceId)))];
    const known = yield* spaces.spacesById(spaceIds).pipe(Effect.catch(storage("read the Spaces")));
    // A configuration's usage: its creator, whoever reads its Space's AI usage, the Owner.
    const usageVisible = new Set(
      rows.flatMap((row) => {
        const space = known.get(SpaceId.make(row.spaceId));
        const reads =
          owner ||
          row.createdBy === input.actorUserId ||
          (space !== undefined &&
            AccessPolicy.isAllowed(
              AccessPolicy.decide(principal, "aiUsage.viewSpace", space.resource),
            ));
        return reads ? [row.configId] : [];
      }),
    );
    const viewable = yield* spaces
      .viewableSpaces(input.actorUserId)
      .pipe(Effect.catch(storage("read your Spaces")));
    const seesThread = (spaceId: string) =>
      viewable === "all" || viewable.includes(SpaceId.make(spaceId));

    const configIds = rows.map((row) => row.configId);
    const read: MakitaUsageRead = yield* usage
      .makitaUsage([...usageVisible])
      .pipe(Effect.catch(storage("read Makita's usage")));
    const now = yield* Clock.currentTimeMillis;
    const starts = {
      today: periodOf("day", now).fromDay,
      week: periodOf("week", now).fromDay,
      month: periodOf("month", now).fromDay,
    };

    // Ticket 06's «Stop now» on a task: whoever may pause its configuration (`makita.pause`).
    const permitted = new Map<string, boolean>();
    const mayStop = Effect.fn("MakitaActivity.mayStop")(function* (row: ConfigRow) {
      const space = known.get(SpaceId.make(row.spaceId));
      if (space === undefined) return false;
      if (!permitted.has(row.spaceId)) {
        permitted.set(
          row.spaceId,
          yield* permittedIn(sql, input.actorUserId, space.resource.id).pipe(
            Effect.catch(storage("read who may use Makita")),
          ),
        );
      }
      return AccessPolicy.isAllowed(
        AccessPolicy.decide(principal, "makita.pause", {
          kind: "makita-config",
          space: space.resource,
          createdBy: UserId.make(row.createdBy),
          permitted: permitted.get(row.spaceId) === true,
          pausedByOwner: row.pausedReason === "owner",
        } satisfies AccessPolicy.MakitaConfigResource),
      );
    });
    const configs: Array<MakitaActivityConfig> = [];
    for (const row of rows) {
      const visible = usageVisible.has(row.configId);
      configs.push({
        configId: row.configId,
        name: row.name,
        spaceId: SpaceId.make(row.spaceId),
        spaceName: known.get(SpaceId.make(row.spaceId))?.name ?? null,
        pausedAt: row.pausedAt,
        usage: visible
          ? yield* withUnwritten(
              read.configs.get(row.configId) ?? MAKITA_NO_PERIODS,
              AiGatewayActivity.makitaConfigSubject(row.configId),
              starts,
            )
          : null,
        canStop: yield* mayStop(row),
      });
    }

    const inConfigs = configIds.length === 0 ? sql`1 = 0` : sql.in("config_id", configIds);
    const live = yield* sql<TaskRow>`
      SELECT ${sql.literal(TASK_COLUMNS)} FROM makita_tasks
      WHERE ${inConfigs} AND ${sql.in("state", [...LIVE_STATES])}
      ORDER BY created_at DESC, task_id LIMIT ${MAX_LIVE}
    `.pipe(Effect.catch(storage("read Makita's tasks")));
    const recent = yield* sql<TaskRow>`
      SELECT ${sql.literal(TASK_COLUMNS)} FROM makita_tasks WHERE ${inConfigs}
      ORDER BY created_at DESC, task_id LIMIT ${RECENT_TASKS}
    `.pipe(Effect.catch(storage("read Makita's tasks")));
    const liveIds = new Set(live.map((task) => task.taskId));
    const shownTask = Effect.fn("MakitaActivity.shownTask")(function* (row: TaskRow) {
      let taskUsage: MakitaUsage | null = null;
      if (usageVisible.has(row.configId)) {
        taskUsage = read.threads.get(row.threadId)?.total ?? MAKITA_NO_USAGE;
        if (liveIds.has(row.taskId)) {
          for (const use of yield* gateway.unwritten(
            AiGatewayActivity.makitaThreadSubject(row.threadId),
          )) {
            taskUsage = addMakitaUsage(taskUsage, {
              requests: use.requests,
              tokens: use.tokens,
              estimatedUsd: null,
            });
          }
        }
      }
      return {
        taskId: row.taskId,
        configId: row.configId,
        repo: row.repo,
        number: row.number,
        kind: row.kind,
        state: row.state,
        callerLogin: row.callerLogin,
        failure: row.failure,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        threadId: seesThread(row.spaceId) ? ThreadId.make(row.threadId) : null,
        usage: taskUsage,
      } satisfies MakitaActivityTask;
    });
    const nowTasks = yield* Effect.forEach(live, shownTask);
    const tasks = yield* Effect.forEach(recent, shownTask);

    const events = yield* sql<MakitaActivityEvent>`
      SELECT config_id AS "configId", repo, number, kind, actor_login AS "actorLogin", outcome,
        detail, seen_at AS "seenAt", task_id AS "taskId"
      FROM makita_events WHERE ${inConfigs}
      ORDER BY seen_at DESC, event_key LIMIT ${RECENT_EVENTS}
    `.pipe(Effect.catch(storage("read Makita's events")));

    // Per repository and per caller: the Threads of configurations whose usage the viewer sees.
    const usedThreads = [...read.threads.keys()];
    const owners =
      usedThreads.length === 0
        ? []
        : yield* sql<{
            readonly threadId: string;
            readonly repo: string;
            readonly callerLogin: string;
          }>`
            SELECT thread_id AS "threadId", repo, caller_login AS "callerLogin"
            FROM makita_tasks WHERE ${sql.in("thread_id", usedThreads)}
          `.pipe(Effect.catch(storage("read Makita's tasks")));
    const byRepository = new Map<string, MakitaUsagePeriods>();
    const byCaller = new Map<string, MakitaUsagePeriods>();
    const addPeriods = (a: MakitaUsagePeriods, b: MakitaUsagePeriods): MakitaUsagePeriods => ({
      today: addMakitaUsage(a.today, b.today),
      week: addMakitaUsage(a.week, b.week),
      month: addMakitaUsage(a.month, b.month),
    });
    for (const task of owners) {
      const used = read.threads.get(task.threadId);
      if (used === undefined) continue;
      byRepository.set(
        task.repo,
        addPeriods(byRepository.get(task.repo) ?? MAKITA_NO_PERIODS, used.periods),
      );
      byCaller.set(
        task.callerLogin,
        addPeriods(byCaller.get(task.callerLogin) ?? MAKITA_NO_PERIODS, used.periods),
      );
    }
    const rowsOf = (map: Map<string, MakitaUsagePeriods>): Array<MakitaUsageBreakdownRow> =>
      [...map]
        .filter(([, periods]) => periods.month.requests + periods.week.requests > 0)
        .map(([label, periods]) => ({ label, usage: periods }))
        .toSorted(
          (a, b) => b.usage.month.tokens - a.usage.month.tokens || a.label.localeCompare(b.label),
        );

    return {
      configs,
      everyone,
      now: nowTasks,
      tasks,
      events,
      byRepository: rowsOf(byRepository),
      byCaller: rowsOf(byCaller),
    } satisfies MakitaActivityResult;
  });

  const threads = Effect.fn("MakitaActivity.threads")(function* (actorUserId: UserId) {
    const viewable = yield* spaces
      .viewableSpaces(actorUserId)
      .pipe(Effect.catch(storage("read your Spaces")));
    if (viewable !== "all" && viewable.length === 0) return { threads: [] };
    const rows = yield* sql<{
      readonly threadId: string;
      readonly repo: string;
      readonly number: number;
      readonly kind: MakitaActivityTask["kind"];
      readonly callerLogin: string;
      readonly state: MakitaActivityTask["state"];
    }>`
      SELECT thread_id AS "threadId", repo, number, kind, caller_login AS "callerLogin", state
      FROM makita_tasks
      WHERE ${viewable === "all" ? sql`1 = 1` : sql.in("space_id", [...viewable])}
      ORDER BY created_at DESC, task_id LIMIT ${MAX_THREADS}
    `.pipe(Effect.catch(storage("read Makita's tasks")));
    return {
      threads: rows.map((row) => ({ ...row, threadId: ThreadId.make(row.threadId) })),
    } satisfies MakitaThreadsResult;
  });

  /** The person behind a WS session: never an agent, the Hub's shell or a one-Space session. */
  const sessionUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    if (actor._tag !== "User" || actor.via !== undefined || actor.spaceLimit !== undefined) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    return actor.userId;
  });

  return MakitaActivity.of({
    activity,
    threads,
    activityForSession: Effect.fn("MakitaActivity.activityAsSession")(function* (
      input: MakitaActivityInput,
    ) {
      return yield* activity({ ...input, actorUserId: yield* sessionUser });
    }),
    threadsForSession: Effect.gen(function* () {
      return yield* threads(yield* sessionUser);
    }).pipe(Effect.withSpan("MakitaActivity.threadsAsSession")),
  });
});

/** Needs the AI usage log and the gateway's activity (what is not written yet). */
export const layer = Layer.effect(MakitaActivity, make);

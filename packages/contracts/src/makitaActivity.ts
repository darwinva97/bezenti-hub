import * as Schema from "effect/Schema";

import { NonNegativeInt, SpaceId, ThreadId } from "./baseSchemas.ts";

/**
 * Makita ticket 07: what Makita does and spends, shown to those who may see it. Makita has no
 * token limits (the Owner's decision): this is visibility, never a cap. Never a token, an issue's
 * text or a comment's.
 */

/**
 * Requests and tokens of some Makita work. `tokens` counts as the Hub's caps do elsewhere: input
 * not read from a cache, output and cache writes. `estimatedUsd`: at list prices, only for
 * `api-key` accounts; null when nothing is priced.
 */
export const MakitaUsage = Schema.Struct({
  requests: NonNegativeInt,
  tokens: NonNegativeInt,
  estimatedUsd: Schema.NullOr(Schema.Number),
});
export type MakitaUsage = typeof MakitaUsage.Type;

/** UTC calendar periods holding now (the week starts on Monday). */
export const MakitaUsagePeriods = Schema.Struct({
  today: MakitaUsage,
  week: MakitaUsage,
  month: MakitaUsage,
});
export type MakitaUsagePeriods = typeof MakitaUsagePeriods.Type;

export const MakitaTaskState = Schema.Literals([
  "awaiting-approval",
  "running",
  "waiting-ci",
  "waiting-reply",
  "done",
  "stopped",
  "failed",
]);
export type MakitaTaskState = typeof MakitaTaskState.Type;

/** What became of an event Makita read on GitHub. */
export const MakitaEventOutcome = Schema.Literals([
  "started",
  "queued",
  "ignored-not-allowed",
  "ignored-bot",
  "ignored-self",
  "ignored-paused",
  "ignored-no-config",
  "ignored-edited",
  "ignored-not-approver",
  "guard",
  "approval",
  "land",
  "command",
]);
export type MakitaEventOutcome = typeof MakitaEventOutcome.Type;

export const MakitaItemKind = Schema.Literals(["issue", "pull"]);
export type MakitaItemKind = typeof MakitaItemKind.Type;

/**
 * Makita ticket 12: the CI of a task's pull request on the commit Makita pushed last: running,
 * passed, failed (the agent is fixing it), failed after 3 fixes, no CI, unfinished in 90 minutes,
 * or no longer watched (the PR closed, or someone else pushed to it).
 */
export const MakitaCiState = Schema.Literals([
  "pending",
  "green",
  "red",
  "gave-up",
  "no-ci",
  "timeout",
  "closed",
  "moved",
]);
export type MakitaCiState = typeof MakitaCiState.Type;

/** A configuration in the activity: its usage only to whoever may see it (else null). */
export const MakitaActivityConfig = Schema.Struct({
  configId: Schema.String,
  name: Schema.String,
  spaceId: SpaceId,
  spaceName: Schema.NullOr(Schema.String),
  pausedAt: Schema.NullOr(Schema.String),
  /** Null: the viewer may not see this configuration's usage (another creator's, a Member). */
  usage: Schema.NullOr(MakitaUsagePeriods),
  /** Whether the viewer may stop its tasks (`makita.tasks.stop`; the Hub decides again). */
  canStop: Schema.Boolean,
  /** Ticket 11: whether the viewer may approve its waiting pushes from the Hub (the Owner). */
  canApprove: Schema.Boolean,
  /** Ticket 22: its tasks at work at once. */
  maxTasks: Schema.Number,
});
export type MakitaActivityConfig = typeof MakitaActivityConfig.Type;

/**
 * Ticket 22: an issue waiting for a free slot of its configuration, oldest first. `position` is
 * its place in that configuration's line only (other Spaces' work is never counted here).
 */
export const MakitaWaitingItem = Schema.Struct({
  configId: Schema.String,
  repo: Schema.String,
  number: NonNegativeInt,
  kind: MakitaItemKind,
  /** The GitHub login that asked (public on GitHub). */
  actorLogin: Schema.NullOr(Schema.String),
  since: Schema.String,
  position: NonNegativeInt,
});
export type MakitaWaitingItem = typeof MakitaWaitingItem.Type;

export const MakitaActivityTask = Schema.Struct({
  taskId: Schema.String,
  configId: Schema.String,
  /** `owner/name` on GitHub. */
  repo: Schema.String,
  number: NonNegativeInt,
  kind: MakitaItemKind,
  state: MakitaTaskState,
  callerLogin: Schema.String,
  failure: Schema.NullOr(Schema.String),
  /** Ticket 12: its pull request on GitHub (public), and how its CI went; null before it. */
  prNumber: Schema.NullOr(NonNegativeInt),
  ci: Schema.NullOr(MakitaCiState),
  /** Ticket 13: the commit GitHub made on the base when an approver's order landed its PR. */
  landedSha: Schema.NullOr(Schema.String),
  /** Ticket 24: what Makita last reported on the issue (reproduced or not); null before. */
  reproduced: Schema.NullOr(Schema.Literals(["yes", "no"])),
  /** Ticket 24: the labels Makita set on its issue or PR and has not removed. */
  labels: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Null when the viewer may not see the Thread: no link then. */
  threadId: Schema.NullOr(ThreadId),
  /** Its usage so far (last 90 days, a live task's not yet written included); null as above. */
  usage: Schema.NullOr(MakitaUsage),
  /** Ticket 11: a push waiting for an approver; `approved` once one approved it, until sent. */
  waitingPush: Schema.NullOr(
    Schema.Struct({
      branch: Schema.String,
      sha: Schema.String,
      commits: NonNegativeInt,
      files: NonNegativeInt,
      additions: NonNegativeInt,
      deletions: NonNegativeInt,
      approved: Schema.Boolean,
    }),
  ),
  /** Its last approval: a `/makita ok` (the approver's public login) or the Owner on the Hub. */
  lastApproval: Schema.NullOr(
    Schema.Struct({
      via: Schema.Literals(["github", "hub"]),
      login: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  ),
});
export type MakitaActivityTask = typeof MakitaActivityTask.Type;

export const MakitaActivityEvent = Schema.Struct({
  configId: Schema.String,
  repo: Schema.String,
  number: NonNegativeInt,
  kind: MakitaItemKind,
  /** The GitHub login that caused it (public on GitHub); null when unknown. */
  actorLogin: Schema.NullOr(Schema.String),
  outcome: MakitaEventOutcome,
  /** Why, in a word the Hub chose (`pull-request`, `task-open`, `creator-left`…); never issue text. */
  detail: Schema.NullOr(Schema.String),
  seenAt: Schema.String,
  taskId: Schema.NullOr(Schema.String),
});
export type MakitaActivityEvent = typeof MakitaActivityEvent.Type;

/** Usage of one repository or one caller, over the configurations whose usage the viewer sees. */
export const MakitaUsageBreakdownRow = Schema.Struct({
  /** `owner/name`, or a GitHub login. */
  label: Schema.String,
  usage: MakitaUsagePeriods,
});
export type MakitaUsageBreakdownRow = typeof MakitaUsageBreakdownRow.Type;

/** One configuration, one Space's, or (neither) the Owner's view of every configuration. */
export const MakitaActivityInput = Schema.Struct({
  configId: Schema.optionalKey(Schema.String),
  spaceId: Schema.optionalKey(SpaceId),
});
export type MakitaActivityInput = typeof MakitaActivityInput.Type;

export const MakitaActivityResult = Schema.Struct({
  configs: Schema.Array(MakitaActivityConfig),
  /** True for the Owner's view of every configuration. */
  everyone: Schema.Boolean,
  /** Tasks at work now: running, waiting for CI, or with a push waiting for an approval. */
  now: Schema.Array(MakitaActivityTask),
  /** Ticket 22: issues waiting for a free slot, in the order they will start. */
  waiting: Schema.Array(MakitaWaitingItem),
  /** The most recent tasks, newest first. */
  tasks: Schema.Array(MakitaActivityTask),
  /** The most recent events and what became of each, newest first. */
  events: Schema.Array(MakitaActivityEvent),
  byRepository: Schema.Array(MakitaUsageBreakdownRow),
  byCaller: Schema.Array(MakitaUsageBreakdownRow),
});
export type MakitaActivityResult = typeof MakitaActivityResult.Type;

/** A Makita task's Thread, for its header and the Thread list's «Makita» filter. */
export const MakitaThread = Schema.Struct({
  threadId: ThreadId,
  repo: Schema.String,
  number: NonNegativeInt,
  kind: MakitaItemKind,
  callerLogin: Schema.String,
  state: MakitaTaskState,
});
export type MakitaThread = typeof MakitaThread.Type;

export const MakitaThreadsInput = Schema.Struct({});
export type MakitaThreadsInput = typeof MakitaThreadsInput.Type;

export const MakitaThreadsResult = Schema.Struct({
  /** The Makita tasks of the Threads the viewer may see, newest first (at most 500). */
  threads: Schema.Array(MakitaThread),
});
export type MakitaThreadsResult = typeof MakitaThreadsResult.Type;

/** The issue or pull request on GitHub (the Hub itself is never linked from GitHub). */
export const makitaItemUrl = (item: {
  readonly repo: string;
  readonly number: number;
  readonly kind: MakitaItemKind;
}) => `https://github.com/${item.repo}/${item.kind === "pull" ? "pull" : "issues"}/${item.number}`;

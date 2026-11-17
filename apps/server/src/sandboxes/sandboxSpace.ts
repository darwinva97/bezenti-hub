import {
  type EnvironmentId,
  GrantLimits,
  HUB_MACHINE_ENVIRONMENT_ID,
  SandboxHostReport,
  SpaceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { DISK_MEASURE_FAILURES_ALLOWED, formatBytes, minHostFreeBytes } from "./sandboxLimits.ts";

/** The Space a Sandbox's Environment id names, whether or not the Sandbox exists yet. */
export const sandboxSpaceOf = (environmentId: EnvironmentId) =>
  environmentId.startsWith("sandbox:")
    ? SpaceId.make(environmentId.slice("sandbox:".length))
    : undefined;

/** A Thread no longer in the Sandbox's Space (its Project moved): nothing new runs for it there. */
export class SandboxSpaceMismatchError extends Schema.TaggedError<SandboxSpaceMismatchError>()(
  "SandboxSpaceMismatchError",
  { environmentId: Schema.String, threadId: Schema.String },
) {
  override get message(): string {
    return "This Thread is no longer in its Sandbox's Space. Move it to another Environment.";
  }
}

/** The Hub could not read which Space an Environment serves: nothing runs there until it can. */
export class SpaceCheckUnavailableError extends Schema.TaggedError<SpaceCheckUnavailableError>()(
  "SpaceCheckUnavailableError",
  { environmentId: Schema.String, cause: Schema.Defect() },
) {
  readonly retryable = true;
  override get message(): string {
    return "The Hub could not check this Environment's Space. Try again.";
  }
}

/**
 * The Space an Environment serves alone: a Sandbox's, or a dedicated machine's; undefined for
 * one that serves its owner anywhere. A failed read fails, never reads as "no Space".
 */
export const boundSpaceOf = Effect.fn("boundSpaceOf")(function* (environmentId: EnvironmentId) {
  const sandboxSpace = sandboxSpaceOf(environmentId);
  if (sandboxSpace !== undefined) return sandboxSpace;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly spaceId: string }>`
    SELECT space_id AS "spaceId" FROM environments
    WHERE environment_id = ${environmentId} AND mode IN ('dedicated', 'lent')
      AND space_id IS NOT NULL
  `.pipe(Effect.mapError((cause) => new SpaceCheckUnavailableError({ environmentId, cause })));
  const spaceId = rows[0]?.spaceId;
  return spaceId === undefined ? undefined : SpaceId.make(spaceId);
});

/** Why a machine does not run Threads of a Space; each refusal says it in its own words. */
export type SpaceRefusal =
  | "other-space"
  | "owner-left"
  | "revoked"
  | "undedicated"
  | "unknown-machine"
  /** A Sandbox on a lent machine whose loan ended (or whose host or lender is gone). */
  | "lent-ended";

export const SPACE_REFUSAL_MESSAGES: Readonly<Record<SpaceRefusal, string>> = {
  "other-space": "This Thread is no longer in its machine's Space. Move it to another Environment.",
  "owner-left":
    "This Thread's machine belongs to someone no longer in its Space. Move it to another Environment.",
  revoked: "This Thread's machine was removed from the Hub. Move it to another Environment.",
  undedicated:
    "This Thread's machine is not dedicated to any Space now. Move it to another Environment.",
  "unknown-machine": "The Hub does not know this Thread's machine. Move it to another Environment.",
  "lent-ended":
    "The machine this Thread ran on is no longer lent to its Space. Move it to another Environment.",
};

/**
 * Why the Environment does not run the Thread `threadId` (of Space `spaceId`), or undefined when
 * it does: the Hub machine runs any; a removed or unknown machine none; a Sandbox or dedicated
 * machine its own Space's; a personal machine while its enabled owner is the Owner or an Admin or
 * Member there, or a Guest there and the Thread is theirs (its own owner, else its root's).
 */
export const spaceRefusalOf = Effect.fn("spaceRefusalOf")(function* (
  environmentId: EnvironmentId,
  spaceId: string | null,
  threadId: string | undefined,
) {
  if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly kind: string;
    readonly mode: string;
    readonly spaceId: string | null;
    readonly revoked: number;
    readonly usable: number;
    readonly lentLive: number;
  }>`
    SELECT e.kind AS kind, e.mode AS mode, e.space_id AS "spaceId",
      e.revoked_at IS NOT NULL AS revoked,
      (e.mode <> 'lent' OR EXISTS (
        SELECT 1 FROM grants g
        JOIN environments host ON host.environment_id = e.host_environment_id
        JOIN users lender ON lender.user_id = host.owner_user_id
        WHERE g.grant_id = e.grant_id AND g.state = 'active' AND host.revoked_at IS NULL
          AND host.mode = 'personal'
          AND lender.disabled_at IS NULL AND lender.removed_at IS NULL
      )) AS "lentLive",
      COALESCE(u.removed_at IS NULL AND u.disabled_at IS NULL AND (
        u.is_owner = 1
        OR ${spaceId} = 'personal:' || u.user_id
        OR EXISTS (SELECT 1 FROM space_memberships m
          WHERE m.user_id = u.user_id AND m.space_id = ${spaceId} AND m.role <> 'guest')
        OR (EXISTS (SELECT 1 FROM space_memberships m
            WHERE m.user_id = u.user_id AND m.space_id = ${spaceId} AND m.role = 'guest')
          AND u.user_id = (
            SELECT COALESCE(t.owner_user_id, root.owner_user_id)
            FROM orchestration_v2_projection_threads t
            LEFT JOIN orchestration_v2_projection_threads root
              ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
            WHERE t.thread_id = ${threadId ?? null}))
      ), 0) AS usable
    FROM environments e LEFT JOIN users u ON u.user_id = e.owner_user_id
    WHERE e.environment_id = ${environmentId}
  `.pipe(Effect.mapError((cause) => new SpaceCheckUnavailableError({ environmentId, cause })));
  if (row === undefined) return "unknown-machine" as const;
  if (row.mode === "lent" && (row.revoked === 1 || row.lentLive !== 1)) {
    return "lent-ended" as const;
  }
  if (row.revoked === 1) return "revoked" as const;
  if (row.kind === "hub") return undefined;
  if (row.kind === "sandbox" || row.mode === "dedicated") {
    if (row.spaceId === null) return "undedicated" as const;
    return row.spaceId === spaceId ? undefined : ("other-space" as const);
  }
  return row.usable === 1 ? undefined : ("owner-left" as const);
});

/** What a lent Sandbox's host last said of it: its state and its home's size. */
export const LentSandboxDisk = Schema.Struct({
  state: Schema.String,
  message: Schema.NullOr(Schema.String),
  usedBytes: Schema.NullOr(Schema.Number),
  failures: Schema.Int,
  measuredAt: Schema.String,
});
const decodeLentDisk = Schema.decodeUnknownOption(Schema.fromJsonString(LentSandboxDisk));
const decodeLimits = Schema.decodeUnknownOption(Schema.fromJsonString(GrantLimits));
const decodeHost = Schema.decodeUnknownOption(Schema.fromJsonString(SandboxHostReport));

/**
 * A lent Sandbox's home is over its Grant's disk limit, or could not be measured three times in a
 * row: no new turn starts there; terminals and files still work, so it can be cleaned up.
 */
export class LentSandboxDiskFullError extends Schema.TaggedError<LentSandboxDiskFullError>()(
  "LentSandboxDiskFullError",
  {
    environmentId: Schema.String,
    usedBytes: Schema.NullOr(Schema.Number),
    limitBytes: Schema.Number,
    unmeasurable: Schema.Boolean,
  },
) {
  override get message(): string {
    return this.unmeasurable
      ? `The disk use of this Thread's lent machine could not be measured ${DISK_MEASURE_FAILURES_ALLOWED} times in a row, so it counts as over its ${formatBytes(this.limitBytes)} limit. Make every file in it readable (terminals and files still work), or ask its lender to look.`
      : `This Thread's lent machine is over its disk limit: it uses ${formatBytes(this.usedBytes ?? 0)} of ${formatBytes(this.limitBytes)}. Free some space (terminals and files still work), or ask its lender to raise the limit.`;
  }
}

/** The machine lent to the Space is almost out of disk: no new turn starts on its Sandboxes. */
export class LentHostDiskLowError extends Schema.TaggedError<LentHostDiskLowError>()(
  "LentHostDiskLowError",
  { environmentId: Schema.String, freeBytes: Schema.Number, totalBytes: Schema.Number },
) {
  override get message(): string {
    return `The machine lent to this Thread's Space is almost out of disk (${formatBytes(this.freeBytes)} free of ${formatBytes(this.totalBytes)}): new turns wait until its owner frees some.`;
  }
}

/**
 * Why no new turn starts on a lent Sandbox now, from its host's last report: its home over its
 * Grant's disk limit (or unmeasurable), or the host's disk almost full. Undefined otherwise, and
 * for any other Environment.
 */
export const lentSandboxRefusalOf = Effect.fn("lentSandboxRefusalOf")(function* (
  environmentId: EnvironmentId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly diskJson: string | null;
    readonly limitsJson: string | null;
    readonly hostJson: string | null;
  }>`
    SELECT e.last_disk_json AS "diskJson", g.limits_json AS "limitsJson",
      host.sandbox_host_json AS "hostJson"
    FROM environments e
    LEFT JOIN grants g ON g.grant_id = e.grant_id
    LEFT JOIN environments host ON host.environment_id = e.host_environment_id
    WHERE e.environment_id = ${environmentId} AND e.mode = 'lent'
  `.pipe(Effect.mapError((cause) => new SpaceCheckUnavailableError({ environmentId, cause })));
  if (row === undefined) return undefined;
  const host = row.hostJson === null ? undefined : Option.getOrUndefined(decodeHost(row.hostJson));
  if (
    host?.hostFreeBytes != null &&
    host.hostTotalBytes != null &&
    host.hostFreeBytes < minHostFreeBytes(host.hostTotalBytes)
  ) {
    return new LentHostDiskLowError({
      environmentId,
      freeBytes: host.hostFreeBytes,
      totalBytes: host.hostTotalBytes,
    });
  }
  const limits =
    row.limitsJson === null ? undefined : Option.getOrUndefined(decodeLimits(row.limitsJson));
  const disk =
    row.diskJson === null ? undefined : Option.getOrUndefined(decodeLentDisk(row.diskJson));
  if (limits === undefined || disk === undefined) return undefined;
  if (disk.failures >= DISK_MEASURE_FAILURES_ALLOWED) {
    return new LentSandboxDiskFullError({
      environmentId,
      usedBytes: disk.usedBytes,
      limitBytes: limits.diskBytes,
      unmeasurable: true,
    });
  }
  if (disk.usedBytes !== null && disk.usedBytes > limits.diskBytes) {
    return new LentSandboxDiskFullError({
      environmentId,
      usedBytes: disk.usedBytes,
      limitBytes: limits.diskBytes,
      unmeasurable: false,
    });
  }
  return undefined;
});

/** Whether the Environment runs the Thread in `spaceId` (`spaceRefusalOf` says why not). */
export const servesSpace = (
  environmentId: EnvironmentId,
  spaceId: string | null,
  threadId: string | undefined,
) =>
  Effect.map(spaceRefusalOf(environmentId, spaceId, threadId), (refusal) => refusal === undefined);

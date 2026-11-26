import { type MakitaError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { MakitaIssueCloses } from "../../../makita/MakitaIssueCloses.ts";
import { MakitaLanding } from "../../../makita/MakitaLanding.ts";
import { MakitaPullRequests } from "../../../makita/MakitaPullRequests.ts";
import { MakitaPushes } from "../../../makita/MakitaPushes.ts";
import { MakitaTasks } from "../../../makita/MakitaTasks.ts";
import { MakitaTriage } from "../../../makita/MakitaTriage.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MakitaToolkit } from "./tools.ts";

const asFailure = (error: MakitaError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid"
        ? "invalid_request"
        : error.reason === "github" || error.reason === "storage"
          ? "orchestration_error"
          : "capability_denied",
    message: error.message,
  });

/** The calling agent's own Thread: the Hub finds its task from it, never from the call. */
const callerThread = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => scope.thread!.threadId),
);

export const layer = McpToolAccess.toLayer(MakitaToolkit, {
  makita_read_issue: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const tasks = yield* MakitaTasks;
      return yield* tasks.readIssueForThread(yield* callerThread).pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_comment: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const tasks = yield* MakitaTasks;
      return yield* tasks
        .commentForThread(yield* callerThread, input.body, {
          ...(input.on === undefined ? {} : { on: input.on }),
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
          ...(input.report === undefined ? {} : { report: input.report }),
        })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_push: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const pushes = yield* MakitaPushes;
      return yield* pushes.pushForThread(yield* callerThread).pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_open_pull_request: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const pulls = yield* MakitaPullRequests;
      return yield* pulls
        .openForThread(yield* callerThread, {
          title: input.title,
          body: input.body,
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_search: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const triage = yield* MakitaTriage;
      return yield* triage
        .searchForThread(yield* callerThread, {
          query: input.query,
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
        })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_label: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const triage = yield* MakitaTriage;
      return yield* triage
        .labelForThread(yield* callerThread, {
          ...(input.add === undefined ? {} : { add: input.add }),
          ...(input.remove === undefined ? {} : { remove: input.remove }),
          ...(input.on === undefined ? {} : { on: input.on }),
        })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_request_merge: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const landing = yield* MakitaLanding;
      return yield* landing
        .requestForThread(yield* callerThread, { commentId: input.commentId, kind: input.kind })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_request_approval: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const tasks = yield* MakitaTasks;
      return yield* tasks
        .requestApprovalForThread(yield* callerThread, {
          commentId: input.commentId,
          kind: input.kind,
        })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_close_issue: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const closes = yield* MakitaIssueCloses;
      return yield* closes
        .closeForThread(yield* callerThread, {
          verdict: input.verdict,
          ref: input.ref,
          confidence: input.confidence,
          reason: input.reason,
        })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_ci_logs: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const pulls = yield* MakitaPullRequests;
      return yield* pulls
        .ciLogsForThread(yield* callerThread, input.job)
        .pipe(Effect.mapError(asFailure));
    }),
  ),
});

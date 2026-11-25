import { type MakitaError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { MakitaPushes } from "../../../makita/MakitaPushes.ts";
import { MakitaTasks } from "../../../makita/MakitaTasks.ts";
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
        .commentForThread(yield* callerThread, input.body)
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  makita_push: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const pushes = yield* MakitaPushes;
      return yield* pushes.pushForThread(yield* callerThread).pipe(Effect.mapError(asFailure));
    }),
  ),
});

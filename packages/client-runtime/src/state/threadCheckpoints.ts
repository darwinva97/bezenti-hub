import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointFileTotals,
  OrchestrationV2CheckpointSkipped,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  /** A prefix of the changed files when `filesTotal` is set; see `checkpointFileTotals`. */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly filesTotal?: OrchestrationV2CheckpointFileTotals;
  /** False until the Hub's repository has the checkpoint; absent when the Hub keeps no record. */
  readonly uploadedToHub?: boolean;
  /** What the checkpoint left out by rule; absent when nothing was. */
  readonly skipped?: OrchestrationV2CheckpointSkipped;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export function deriveThreadCheckpointSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages">,
): ReadonlyArray<ThreadCheckpointSummary> {
  let assistantMessageIdsByRun: Map<RunId, MessageId | null | undefined> | undefined;
  let nextMessageIndex = -1;
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const messages = projection.messages;
    if (assistantMessageIdsByRun === undefined) {
      assistantMessageIdsByRun = new Map();
      for (const entry of projection.checkpoints) {
        if (entry.appRunOrdinal !== null && entry.runId !== null) {
          assistantMessageIdsByRun.set(entry.runId, undefined);
        }
      }
      nextMessageIndex = messages.length - 1;
    }
    // Resume the reverse scan only as far as this checkpoint needs. Recent
    // checkpoints must not force a traversal of unrelated older history.
    while (nextMessageIndex >= 0 && assistantMessageIdsByRun.get(checkpoint.runId) === undefined) {
      const message = messages[nextMessageIndex--]!;
      const { runId, role } = message;
      if (
        role === "assistant" &&
        runId !== null &&
        assistantMessageIdsByRun.has(runId) &&
        assistantMessageIdsByRun.get(runId) === undefined
      ) {
        assistantMessageIdsByRun.set(runId, message.id ?? null);
      }
    }
    const assistantMessageId = assistantMessageIdsByRun.get(checkpoint.runId) ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        ...(checkpoint.filesTotal === undefined ? {} : { filesTotal: checkpoint.filesTotal }),
        ...(checkpoint.uploadedToHub === undefined
          ? {}
          : { uploadedToHub: checkpoint.uploadedToHub }),
        ...(checkpoint.skipped === undefined ? {} : { skipped: checkpoint.skipped }),
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

export function checkpointFileTotals(
  checkpoint: Pick<ThreadCheckpointSummary, "files" | "filesTotal">,
): OrchestrationV2CheckpointFileTotals {
  if (checkpoint.filesTotal !== undefined) return checkpoint.filesTotal;
  let additions = 0;
  let deletions = 0;
  for (const file of checkpoint.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { count: checkpoint.files.length, additions, deletions };
}

const MiB = 1024 * 1024;
const SKIPPED_FILES_SHOWN = 5;

const formatMiB = (bytes: number) =>
  `${Math.max(1, Math.round(bytes / MiB)).toLocaleString("en-US")} MiB`;

/** The turn's note about files too large for its checkpoint; null when there were none. */
export function checkpointSkippedFilesNote(skipped: OrchestrationV2CheckpointSkipped | undefined): {
  readonly label: string;
  readonly title: string;
  readonly files: ReadonlyArray<string>;
  readonly hint: string;
} | null {
  if (skipped === undefined || skipped.fileCount === 0) return null;
  const one = skipped.fileCount === 1;
  const shown = skipped.files
    .slice(0, SKIPPED_FILES_SHOWN)
    .map((file) => `${file.path} (${formatMiB(file.sizeBytes)})`);
  const rest = skipped.fileCount - shown.length;
  return {
    label: `${skipped.fileCount.toLocaleString("en-US")} ${one ? "file" : "files"} not saved`,
    title: `Not saved in this checkpoint, so reverting leaves ${one ? "it as it is" : "them as they are"}:`,
    files: rest > 0 ? [...shown, `and ${rest.toLocaleString("en-US")} more`] : shown,
    hint: `Files over ${formatMiB(skipped.maxFileBytes)} are left out of checkpoints. Add them to .gitignore to hide this note.`,
  };
}

/** The diff's line about the dependency and build folders checkpoints leave out. */
export function checkpointSkippedFoldersText(
  skipped: OrchestrationV2CheckpointSkipped | undefined,
): string | null {
  if (skipped === undefined || skipped.folderCount === 0) return null;
  const rest = skipped.folderCount - skipped.folders.length;
  const folders = skipped.folders.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
  return `Dependency and build folders are not in checkpoints: ${folders}. To keep one, add a line like !${skipped.folders[0]?.split("/").at(-2) ?? "dist"}/ to .gitignore.`;
}

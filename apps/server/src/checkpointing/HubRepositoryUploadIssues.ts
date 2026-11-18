/**
 * Which Hub repositories each machine's checkpoint uploads keep failing for, and why, as the
 * uploader (`CheckpointUploadService`) last saw it. Kept in memory: after a restart the next
 * attempt says again. The Environments list shows it to whoever manages the machine.
 */
import type { EnvironmentId, HubRepositoryUploadIssue } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class HubRepositoryUploadIssues extends Context.Service<
  HubRepositoryUploadIssues,
  {
    /** Records the repository's issue on the machine (`repository`: any stable key), or clears it. */
    readonly record: (
      environmentId: EnvironmentId,
      repository: string,
      issue: HubRepositoryUploadIssue | null,
    ) => Effect.Effect<void>;
    /** The machine's issues, oldest first. */
    readonly of: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<HubRepositoryUploadIssue>>;
  }
>()("t3/checkpointing/HubRepositoryUploadIssues") {}

export const layer = Layer.sync(HubRepositoryUploadIssues, () => {
  const byMachine = new Map<EnvironmentId, Map<string, HubRepositoryUploadIssue>>();
  return HubRepositoryUploadIssues.of({
    record: Effect.fn("HubRepositoryUploadIssues.record")((environmentId, repository, issue) =>
      Effect.sync(() => {
        const issues = byMachine.get(environmentId) ?? new Map<string, HubRepositoryUploadIssue>();
        if (issue === null) issues.delete(repository);
        else issues.set(repository, issue);
        if (issues.size === 0) byMachine.delete(environmentId);
        else byMachine.set(environmentId, issues);
      }),
    ),
    of: Effect.fn("HubRepositoryUploadIssues.of")((environmentId) =>
      Effect.sync(() =>
        [...(byMachine.get(environmentId)?.values() ?? [])].toSorted((a, b) =>
          a.since.localeCompare(b.since),
        ),
      ),
    ),
  });
});

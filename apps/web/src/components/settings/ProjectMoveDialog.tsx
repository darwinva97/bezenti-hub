import {
  destinationSandbox,
  moveProject,
  projectMovePlan,
} from "@t3tools/client-runtime/spaces/space-directory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ProjectMovePlan,
  type ProjectMovePlanThread,
  type ProjectMoveResult,
  type SpaceId,
  type SpaceSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useState } from "react";

import { aiAccountFallbackName } from "@t3tools/client-runtime/ai-account-picker";
import { useHubEnvironments } from "../../environments/primary/useHubEnvironments";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { errorMessageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { randomUUID } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

type Step =
  | { readonly status: "planning" }
  | { readonly status: "confirm"; readonly plan: ProjectMovePlan }
  | { readonly status: "moving"; readonly plan: ProjectMovePlan }
  | { readonly status: "moved"; readonly plan: ProjectMovePlan }
  | { readonly status: "moving-threads"; readonly plan: ProjectMovePlan }
  | {
      readonly status: "threads-moved";
      readonly plan: ProjectMovePlan;
      readonly failures: ReadonlyArray<string>;
    }
  | { readonly status: "failed"; readonly message: string; readonly plan?: ProjectMovePlan };

export type PlannedMove =
  | { readonly status: "planning" }
  | { readonly status: "ready"; readonly plan: ProjectMovePlan }
  | { readonly status: "failed"; readonly message: string };

/** The Hub refused the move because a Thread runs (409). */
const isConflict = (cause: unknown): boolean => {
  const tagOf = (value: unknown) =>
    typeof value === "object" && value !== null && "_tag" in value ? value._tag : undefined;
  return (
    tagOf(cause) === "EnvironmentHttpConflictError" ||
    tagOf((cause as { readonly cause?: unknown } | null)?.cause) === "EnvironmentHttpConflictError"
  );
};

/** Asks the Hub what moving the Project to `spaceId` would do, never failing. */
export const loadProjectMovePlan = (projectId: ProjectId, spaceId: SpaceId): Promise<PlannedMove> =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => projectMovePlan(client, { projectId, spaceId })),
    ),
  ).then(
    (plan): PlannedMove => ({ status: "ready", plan }),
    (cause): PlannedMove => ({
      status: "failed",
      message: errorMessageOf(cause, "Could not check the move."),
    }),
  );

/**
 * Moving a Project to another Space: before confirming, which Threads stop and which then need an
 * environment; after it, one action moves those to the destination's Sandbox (spec 2's move).
 */
export function ProjectMoveDialog({
  projectId,
  projectTitle,
  destination,
  primaryEnvironmentId,
  planned,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly destination: SpaceSummary;
  readonly primaryEnvironmentId: EnvironmentId;
  /** The plan, asked for by the action that opened the dialog (`loadProjectMovePlan`). */
  readonly planned: PlannedMove;
  readonly onClose: () => void;
}) {
  const environments = useHubEnvironments();
  const moveThread = useOrchestrationCommand(threadEnvironment.move, { reportFailure: false });
  // Until the mover acts, the dialog shows the plan as it arrives.
  const [acted, setStep] = useState<Step | null>(null);
  const step: Step =
    acted ??
    (planned.status === "ready"
      ? { status: "confirm", plan: planned.plan }
      : planned.status === "failed"
        ? { status: "failed", message: planned.message }
        : { status: "planning" });
  const sandbox = destinationSandbox(environments, destination.id);
  const nameOf = (thread: ProjectMovePlanThread) =>
    environments.find((environment) => environment.id === thread.environmentId)?.name ??
    "a machine that does not serve it";

  const confirm = async (plan: ProjectMovePlan) => {
    setStep({ status: "moving", plan });
    let released: ProjectMoveResult["released"];
    try {
      released = (
        await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) =>
              moveProject(client, {
                commandId: CommandId.make(`project-move:${randomUUID()}`),
                projectId,
                spaceId: destination.id,
                stopThreads: plan.running.length > 0,
              }),
            ),
          ),
        )
      ).released;
    } catch (cause) {
      // A Thread started running since the plan: show the plan as it is now, to confirm again.
      if (isConflict(cause)) {
        const fresh = await loadProjectMovePlan(projectId, destination.id);
        if (fresh.status === "ready") {
          setStep({ status: "confirm", plan: fresh.plan });
          return;
        }
      }
      setStep({ status: "failed", plan, message: errorMessageOf(cause, "Try again.") });
      return;
    }
    toastManager.add({ type: "success", title: `Moved to ${destination.name}` });
    if (released.length === 0) {
      onClose();
      return;
    }
    // What the move actually released, not what the plan expected.
    setStep({ status: "moved", plan: { ...plan, running: [], needsEnvironment: released } });
  };

  const moveAll = async (plan: ProjectMovePlan) => {
    if (sandbox === undefined) return;
    setStep({ status: "moving-threads", plan });
    const failures: Array<string> = [];
    for (const thread of plan.needsEnvironment) {
      const result = await moveThread({
        environmentId: primaryEnvironmentId,
        input: { threadId: thread.threadId, targetEnvironmentId: sandbox.id, ifRunning: "stop" },
      });
      if (result._tag === "Success") continue;
      const error = squashAtomCommandFailure(result);
      failures.push(
        `${thread.title}: ${error instanceof Error ? error.message : "it could not be moved."}`,
      );
    }
    setStep({ status: "threads-moved", plan, failures });
  };

  const plan = "plan" in step ? step.plan : undefined;
  const busy = step.status === "moving" || step.status === "moving-threads";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Move to {destination.name}</DialogTitle>
          <DialogDescription>
            {`"${projectTitle}" and its Threads move to ${destination.name}. Who can see it changes to ${destination.name}'s people, and it uses ${destination.name}'s vaults and AI accounts from now on.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4 text-sm">
            {step.status === "planning" ? <p role="status">Checking what changes…</p> : null}
            {plan !== undefined && (step.status === "confirm" || step.status === "moving") ? (
              <>
                {plan.running.length > 0 ? (
                  <section aria-label="Threads that stop">
                    <p className="font-medium">
                      {plan.running.length === 1
                        ? "1 running Thread stops:"
                        : `${plan.running.length} running Threads stop:`}
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {plan.running.map((thread) => (
                        <li key={thread.threadId}>{thread.title}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {plan.needsEnvironment.length > 0 ? (
                  <section aria-label="Threads that change Environment">
                    <p className="font-medium">
                      {`These Threads run on machines that do not serve ${destination.name}; they will need an environment:`}
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {plan.needsEnvironment.map((thread) => (
                        <li key={thread.threadId}>
                          {thread.title}{" "}
                          <span className="text-muted-foreground">({nameOf(thread)})</span>
                        </li>
                      ))}
                    </ul>
                    {sandbox === undefined ? null : (
                      <p className="mt-1 text-muted-foreground">
                        {`After the move you can move them all to ${sandbox.name}.`}
                      </p>
                    )}
                  </section>
                ) : null}
                {plan.running.length === 0 && plan.needsEnvironment.length === 0 ? (
                  <p>Every Thread keeps its Environment.</p>
                ) : null}
                {plan.vaultsLost.length > 0 ? (
                  <section aria-label="Vaults it loses">
                    <p className="font-medium">
                      {`Its Threads stop receiving the secrets of ${plan.vaultsLost.length === 1 ? "this group" : "these groups"}:`}
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {plan.vaultsLost.map((vault) => (
                        <li key={vault.vaultId}>
                          {vault.name}
                          {vault.ownerName ? (
                            <span className="text-muted-foreground">{` (${vault.ownerName}'s vault)`}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {plan.aiAccountsLost.length > 0 ? (
                  <section aria-label="AI accounts it loses">
                    <p className="font-medium">
                      {`${destination.name} does not allow ${plan.aiAccountsLost.length === 1 ? "this AI account" : "these AI accounts"} for its Threads; they switch to the first one allowed there, or need one:`}
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {plan.aiAccountsLost.map((account) => (
                        <li key={account.aiAccountId}>
                          {account.name ?? aiAccountFallbackName(account.provider)}{" "}
                          <span className="text-muted-foreground">
                            {account.threads === 1 ? "(1 Thread)" : `(${account.threads} Threads)`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                <p>Open terminals of its Threads close.</p>
              </>
            ) : null}
            {plan !== undefined && (step.status === "moved" || step.status === "moving-threads") ? (
              <p role="status">
                {`Moved. ${plan.needsEnvironment.length === 1 ? "1 Thread needs" : `${plan.needsEnvironment.length} Threads need`} an environment.`}
                {sandbox === undefined
                  ? ` ${destination.name} has no Sandbox here; move each one from its Thread.`
                  : ""}
              </p>
            ) : null}
            {step.status === "threads-moved" ? (
              <div role="status">
                <p>
                  {step.failures.length === 0
                    ? `Moving ${step.plan.needsEnvironment.length === 1 ? "the Thread" : "the Threads"} to ${sandbox?.name ?? destination.name}. Each Thread shows its move.`
                    : "Some Threads could not be moved:"}
                </p>
                {step.failures.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5">
                    {step.failures.map((failure) => (
                      <li key={failure}>{failure}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {step.status === "failed" ? (
              <p role="alert" className="text-destructive">
                {step.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {step.status === "confirm" || step.status === "moving" ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void confirm(step.plan)} disabled={busy}>
                {busy ? <Spinner /> : null}
                {step.plan.running.length > 0 ? "Stop Threads and move" : "Move"}
              </Button>
            </>
          ) : step.status === "moved" || step.status === "moving-threads" ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Later
              </Button>
              {sandbox === undefined ? null : (
                <Button onClick={() => void moveAll(step.plan)} disabled={busy}>
                  {busy ? <Spinner /> : null}
                  {`Move all to ${sandbox.name}`}
                </Button>
              )}
            </>
          ) : (
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

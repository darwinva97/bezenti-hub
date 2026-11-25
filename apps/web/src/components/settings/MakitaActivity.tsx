import { formatTokens, formatUsd } from "@t3tools/client-runtime/ai-usage-view";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MakitaActivityInput,
  type MakitaActivityResult,
  type MakitaActivityTask,
  type MakitaCiState,
  type MakitaEventOutcome,
  makitaItemUrl,
  type MakitaUsage,
  type MakitaUsageBreakdownRow,
  type MakitaUsagePeriods,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { makitaEnvironment } from "../../state/makita";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { InfoTip } from "./InfoTip";
import { SettingsSection } from "./settingsLayout";

/**
 * Makita activity (Makita ticket 07): what Makita does now, its recent tasks and events, and what
 * it spends. Makita has no token limits; this is where its spending is seen. The Hub decides
 * what each viewer gets: usage is null where they may not see it.
 */

const USAGE_HIDDEN =
  "Usage shows to a configuration's creator and to whoever reads this Space's AI usage.";

const STATE_LABEL: Readonly<Record<MakitaActivityTask["state"], string>> = {
  "awaiting-approval": "Waiting for approval",
  running: "Running",
  "waiting-ci": "Waiting for CI",
  "waiting-reply": "Waiting for a reply",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

/** Makita ticket 12: its pull request's CI on the commit Makita pushed last. */
const CI_LABEL: Readonly<Record<MakitaCiState, string>> = {
  pending: "CI running",
  green: "CI passed",
  red: "CI failed: fixing",
  "gave-up": "CI failed after 3 fixes",
  "no-ci": "No CI",
  timeout: "CI unfinished after 90 min",
  closed: "PR closed",
  moved: "Someone else pushed",
};

const OUTCOME_LABEL: Readonly<Record<MakitaEventOutcome, string>> = {
  started: "Started a task",
  queued: "Queued",
  "ignored-not-allowed": "Ignored: not on the list",
  "ignored-bot": "Ignored: a bot",
  "ignored-self": "Ignored: Makita itself",
  "ignored-paused": "Ignored: paused",
  "ignored-no-config": "Ignored: nothing to do",
  "ignored-edited": "Ignored: an edited comment",
  "ignored-not-approver": "Ignored: not an approver",
  guard: "Held: waiting for a person",
  approval: "Approval",
  land: "Merge",
  command: "Command",
};

/** A task still at work or waiting: ticket 06's «Stop now» applies. */
const isLive = (task: MakitaActivityTask) =>
  task.state !== "done" && task.state !== "stopped" && task.state !== "failed";

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** «12.3k tokens · ≈$0.42», or «No use». */
export const makitaUsageText = (usage: MakitaUsage) =>
  usage.requests === 0
    ? "No use"
    : `${formatTokens(usage.tokens)} tokens${usage.estimatedUsd === null ? "" : ` · ≈${formatUsd(usage.estimatedUsd)}`}`;

const NO_USAGE: MakitaUsage = { requests: 0, tokens: 0, estimatedUsd: null };
const addUsage = (a: MakitaUsage, b: MakitaUsage): MakitaUsage => ({
  requests: a.requests + b.requests,
  tokens: a.tokens + b.tokens,
  estimatedUsd:
    a.estimatedUsd === null && b.estimatedUsd === null
      ? null
      : (a.estimatedUsd ?? 0) + (b.estimatedUsd ?? 0),
});

/** The visible configurations' periods added up; null when the viewer sees none. */
const totalOf = (activity: MakitaActivityResult): MakitaUsagePeriods | null => {
  const visible = activity.configs.flatMap((config) =>
    config.usage === null ? [] : [config.usage],
  );
  if (visible.length === 0) return null;
  return visible.reduce(
    (sum, periods) => ({
      today: addUsage(sum.today, periods.today),
      week: addUsage(sum.week, periods.week),
      month: addUsage(sum.month, periods.month),
    }),
    { today: NO_USAGE, week: NO_USAGE, month: NO_USAGE },
  );
};

/** One configuration's, one Space's or (the Owner) every configuration's activity, kept fresh. */
export function useMakitaActivity(environmentId: EnvironmentId | null, input: MakitaActivityInput) {
  return useEnvironmentQuery(
    environmentId === null ? null : makitaEnvironment.activity({ environmentId, input }),
  );
}

function UsageLine({ total }: { readonly total: MakitaUsagePeriods | null }) {
  if (total === null) return <p className="text-xs text-muted-foreground">{USAGE_HIDDEN}</p>;
  return (
    <p className="text-sm" aria-label="Makita usage">
      <span className="text-muted-foreground">Today </span>
      <span className="font-medium">{makitaUsageText(total.today)}</span>
      <span className="text-muted-foreground"> · This week </span>
      <span className="font-medium">{makitaUsageText(total.week)}</span>
      <span className="text-muted-foreground"> · This month </span>
      <span className="font-medium">{makitaUsageText(total.month)}</span>
    </p>
  );
}

function TaskRow({
  task,
  configName,
  onStop,
  stopping,
}: {
  readonly task: MakitaActivityTask;
  readonly configName: string | null;
  /** Null when the viewer may not stop it, or it has ended. */
  readonly onStop: (() => void) | null;
  readonly stopping: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-xs">
      <a
        className="font-medium hover:underline"
        href={makitaItemUrl(task)}
        target="_blank"
        rel="noreferrer"
      >
        {task.repo}#{task.number}
      </a>
      <Badge
        size="sm"
        variant={
          task.state === "failed" ? "error" : task.state === "running" ? "info" : "secondary"
        }
      >
        {STATE_LABEL[task.state]}
      </Badge>
      {task.prNumber === null ? null : (
        <a
          className="hover:underline"
          href={makitaItemUrl({ repo: task.repo, number: task.prNumber, kind: "pull" })}
          target="_blank"
          rel="noreferrer"
        >
          PR #{task.prNumber}
        </a>
      )}
      {task.ci === null ? null : (
        <Badge
          size="sm"
          variant={
            task.ci === "green" ? "success" : task.ci === "pending" ? "secondary" : "warning"
          }
        >
          {CI_LABEL[task.ci]}
        </Badge>
      )}
      <span className="text-muted-foreground">
        {`@${task.callerLogin} · since ${formatWhen(task.createdAt)}`}
        {configName === null ? "" : ` · ${configName}`}
        {task.failure === null ? "" : ` · ${task.failure}`}
        {task.usage === null ? "" : ` · ${makitaUsageText(task.usage)}`}
      </span>
      <span className="ms-auto flex items-center gap-2">
        {task.threadId === null ? null : (
          <Link
            className="text-primary hover:underline"
            to="/$threadId"
            params={{ threadId: task.threadId }}
          >
            Open Thread
          </Link>
        )}
        {onStop === null ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={stopping}
            aria-label={`Stop ${task.repo}#${task.number} now`}
            title="Interrupts its turn. Makita writes nothing on GitHub about it."
            onClick={onStop}
          >
            Stop now
          </Button>
        )}
      </span>
    </li>
  );
}

function BreakdownTable({
  label,
  rows,
}: {
  readonly label: string;
  readonly rows: ReadonlyArray<MakitaUsageBreakdownRow>;
}) {
  if (rows.length === 0) return null;
  return (
    <Table aria-label={`Makita usage by ${label.toLowerCase()}`}>
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className="text-end">Today</TableHead>
          <TableHead className="text-end">This week</TableHead>
          <TableHead className="text-end">This month</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.label}>
            <TableCell>{row.label}</TableCell>
            <TableCell className="text-end">{makitaUsageText(row.usage.today)}</TableCell>
            <TableCell className="text-end">{makitaUsageText(row.usage.week)}</TableCell>
            <TableCell className="text-end">{makitaUsageText(row.usage.month)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const TABS = [
  ["now", "Now"],
  ["tasks", "Tasks"],
  ["events", "Events"],
  ["usage", "Usage"],
] as const;
type Tab = (typeof TABS)[number][0];

/** The activity itself: its usage on one line, the rest one tab at a time (details on demand). */
function ActivityBody({
  activity,
  onStop,
  stopping,
}: {
  readonly activity: MakitaActivityResult;
  readonly onStop: (task: MakitaActivityTask) => void;
  /** The task being stopped now, if any. */
  readonly stopping: string | null;
}) {
  const [tab, setTab] = useState<Tab>("now");
  const names = new Map(activity.configs.map((config) => [config.configId, config.name]));
  const stoppable = new Set(
    activity.configs.flatMap((config) => (config.canStop ? [config.configId] : [])),
  );
  const row = (task: MakitaActivityTask) => (
    <TaskRow
      key={task.taskId}
      task={task}
      configName={nameOf(task.configId)}
      onStop={isLive(task) && stoppable.has(task.configId) ? () => onStop(task) : null}
      stopping={stopping === task.taskId}
    />
  );
  const nameOf = (configId: string) =>
    activity.configs.length > 1 ? (names.get(configId) ?? null) : null;
  const visibleConfigs = activity.configs.filter((config) => config.usage !== null);
  return (
    <div className="flex flex-col gap-3">
      <UsageLine total={totalOf(activity)} />
      <ToggleGroup
        aria-label="Makita activity"
        value={[tab]}
        onValueChange={(next) => {
          const value = TABS.find(([key]) => key === next[0]);
          if (value !== undefined) setTab(value[0]);
        }}
      >
        {TABS.map(([key, label]) => (
          <Toggle key={key} value={key}>
            {label}
            {key === "now" && activity.now.length > 0 ? ` (${activity.now.length})` : ""}
          </Toggle>
        ))}
      </ToggleGroup>
      {tab === "now" ? (
        activity.now.length === 0 ? (
          <p className="text-sm text-muted-foreground">Makita is not working on anything now.</p>
        ) : (
          <ul aria-label="Makita now" className="divide-y divide-border/50">
            {activity.now.map(row)}
          </ul>
        )
      ) : tab === "tasks" ? (
        activity.tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No task yet.</p>
        ) : (
          <ul aria-label="Recent Makita tasks" className="divide-y divide-border/50">
            {activity.tasks.map(row)}
          </ul>
        )
      ) : tab === "events" ? (
        activity.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No event yet.</p>
        ) : (
          <ul aria-label="Recent Makita events" className="divide-y divide-border/50">
            {activity.events.map((event) => (
              <li
                key={`${event.seenAt}-${event.repo}-${event.number}-${event.outcome}-${event.actorLogin ?? ""}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-xs"
              >
                <a
                  className="font-medium hover:underline"
                  href={makitaItemUrl(event)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {event.repo}#{event.number}
                </a>
                <span>
                  {event.outcome === "started" && event.detail === "continued"
                    ? "Continued a task"
                    : OUTCOME_LABEL[event.outcome]}
                </span>
                <span className="text-muted-foreground">
                  {event.actorLogin === null ? "" : `@${event.actorLogin} · `}
                  {formatWhen(event.seenAt)}
                  {event.detail === null ? "" : ` · ${event.detail}`}
                  {nameOf(event.configId) === null ? "" : ` · ${nameOf(event.configId)}`}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : visibleConfigs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{USAGE_HIDDEN}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {activity.configs.length > 1 ? (
            <BreakdownTable
              label="Configuration"
              rows={visibleConfigs.map((config) => ({
                label: activity.everyone
                  ? `${config.name} (${config.spaceName ?? "a Space"})`
                  : config.name,
                usage: config.usage!,
              }))}
            />
          ) : null}
          <BreakdownTable label="Repository" rows={activity.byRepository} />
          <BreakdownTable label="Caller" rows={activity.byCaller} />
          {activity.byRepository.length === 0 ? (
            <p className="text-sm text-muted-foreground">No use this month.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** «Makita activity» for one configuration, one Space, or the Owner's every configuration. */
export function MakitaActivityDialog({
  environmentId,
  input,
  title,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: MakitaActivityInput;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const query = useMakitaActivity(environmentId, input);
  const stopTask = useAtomCommand(makitaEnvironment.stopTask, "stop a Makita task");
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const stop = async (task: MakitaActivityTask) => {
    setStopping(task.taskId);
    setStopError(null);
    const result = await stopTask({ environmentId, input: { taskId: task.taskId } });
    setStopping(null);
    if (result._tag === "Success") query.refresh();
    else setStopError(errorMessageOf(squashAtomCommandFailure(result), "Could not stop it."));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Makita activity</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.data === null ? (
            <p
              className={
                query.error === null ? "text-sm text-muted-foreground" : "text-xs text-destructive"
              }
              role={query.error === null ? undefined : "alert"}
            >
              {query.error ?? "Loading…"}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {stopError === null ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {stopError}
                </p>
              )}
              <ActivityBody
                activity={query.data}
                onStop={(task) => void stop(task)}
                stopping={stopping}
              />
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Platform → Makita, beside «Stop all Makita work»: every configuration's usage and what runs now
 * (the Owner's), with the rest one click away.
 */
export function MakitaOwnerActivity({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useMakitaActivity(environmentId, {});
  const [open, setOpen] = useState(false);
  const activity = query.data;
  return (
    <SettingsSection
      id="makita-activity"
      title="Activity"
      titleAction={
        <InfoTip label="About Makita's activity">
          What Makita does now and what it spends, across every configuration on this Hub. Makita
          has no token limits: stop a configuration in its Space, or all of Makita above.
        </InfoTip>
      }
      headerAction={
        activity === null || activity.configs.length === 0 ? null : (
          <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
            Details…
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-1 px-4 py-3">
        {activity === null ? (
          <p
            className={
              query.error === null ? "text-sm text-muted-foreground" : "text-xs text-destructive"
            }
            role={query.error === null ? undefined : "alert"}
          >
            {query.error ?? "Loading…"}
          </p>
        ) : activity.configs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No configuration yet.</p>
        ) : (
          <>
            <UsageLine total={totalOf(activity)} />
            <p className="text-xs text-muted-foreground" aria-label="Makita now">
              {activity.now.length === 0
                ? `${activity.configs.length} ${activity.configs.length === 1 ? "configuration" : "configurations"} · nothing running now`
                : `${activity.configs.length} ${activity.configs.length === 1 ? "configuration" : "configurations"} · ${activity.now.length} ${activity.now.length === 1 ? "task" : "tasks"} at work: ${activity.now
                    .slice(0, 3)
                    .map((task) => `${task.repo}#${task.number}`)
                    .join(", ")}${activity.now.length > 3 ? "…" : ""}`}
            </p>
          </>
        )}
      </div>
      {open ? (
        <MakitaActivityDialog
          environmentId={environmentId}
          input={{}}
          title="Every configuration on this Hub."
          onClose={() => setOpen(false)}
        />
      ) : null}
    </SettingsSection>
  );
}

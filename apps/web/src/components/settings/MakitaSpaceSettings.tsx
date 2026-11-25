import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AiAccountId,
  type EnvironmentId,
  MAKITA_DEFAULT_LABEL,
  type MakitaConfig,
  type MakitaConfigInput,
  type MakitaConfigSaveResult,
  type MakitaConfigsListResult,
  type MakitaActivityInput,
  type MakitaUsage,
  type ProjectId,
  ProviderInstanceId,
  type SpaceId,
} from "@t3tools/contracts";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { makitaEnvironment } from "../../state/makita";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { InfoTip } from "./InfoTip";
import { MakitaActivityDialog, makitaUsageText, useMakitaActivity } from "./MakitaActivity";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsSpace } from "./useSettingsSpace";

type ListAnswer = AtomCommandResult<MakitaConfigsListResult, unknown>;
type Options = NonNullable<MakitaConfigsListResult["space"]>;

const CI_NOTE =
  "Makita's pull requests run this repository's CI. If CI on branches can read secrets, code in a branch can reach them: keep branch CI without secrets.";
const NOT_ALLOWED =
  "You may not use Makita in this Space. The Owner gives that permission in Platform → Makita.";

/** What hands an issue to a configuration, in one line (Makita ticket 09). */
const triggersText = (triggers: MakitaConfig["triggers"]) =>
  [
    triggers.label === null ? null : `Label «${triggers.label}»`,
    triggers.assigned ? "assigned to Makita" : null,
    triggers.mention ? "a mention" : null,
  ]
    .filter((part) => part !== null)
    .join(", ");

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const PAUSE_REASONS: Readonly<Record<NonNullable<MakitaConfig["pausedReason"]>, string>> = {
  manual: "paused",
  owner: "paused by the Owner",
  "permission-revoked": "its creator may no longer use Makita here",
  "creator-disabled": "its creator is disabled",
  "creator-left": "its creator left",
};

const WARNINGS: Readonly<Record<MakitaConfig["warnings"][number], string>> = {
  "ai-account-unavailable": "This AI account is no longer available to its creator here.",
  "no-repository": "No repository to listen to: no Project here has a GitHub remote.",
  "repo-unreachable":
    "Makita cannot read one of its repositories. Check that the bot is a collaborator there.",
};

/** Whether a failure is the Hub saying the viewer may not see Makita in this Space. */
const isForbidden = (result: ListAnswer) => {
  if (result._tag === "Success") return false;
  const failure = squashAtomCommandFailure(result) as {
    readonly _tag?: string;
    readonly reason?: string;
  };
  return failure?._tag === "MakitaError" && failure.reason === "forbidden";
};

function useConfigCommands() {
  return {
    list: useAtomCommand(makitaEnvironment.listConfigs, "list Makita configurations"),
    create: useAtomCommand(makitaEnvironment.createConfig, "make a Makita configuration"),
    update: useAtomCommand(makitaEnvironment.updateConfig, "change a Makita configuration"),
    remove: useAtomCommand(makitaEnvironment.deleteConfig, "delete a Makita configuration"),
    pause: useAtomCommand(makitaEnvironment.pauseConfig, "pause a Makita configuration"),
    resume: useAtomCommand(makitaEnvironment.resumeConfig, "resume a Makita configuration"),
  };
}

/** Space settings → Makita: the Space's configurations, for who may see them. */
export function SpaceMakitaSection() {
  const space = useSettingsSpace();
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {space === null || environmentId === null ? null : (
        <MakitaConfigsPanel environmentId={environmentId} spaceId={space.id} />
      )}
    </SettingsPageContainer>
  );
}

function MakitaConfigsPanel({
  environmentId,
  spaceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
}) {
  const commands = useConfigCommands();
  const [listed, setListed] = useState<MakitaConfigsListResult | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<ReadonlyArray<string>>([]);
  const [editing, setEditing] = useState<MakitaConfig | "new" | null>(null);
  const [deleting, setDeleting] = useState<MakitaConfig | null>(null);
  const [pending, setPending] = useState(false);
  // Makita ticket 07: today's usage on each row, and the activity of one or all of them.
  const activity = useMakitaActivity(hidden ? null : environmentId, { spaceId });
  const todayOf = new Map(
    (activity.data?.configs ?? []).map((entry) => [entry.configId, entry.usage?.today ?? null]),
  );
  const [showing, setShowing] = useState<{
    readonly input: MakitaActivityInput;
    readonly title: string;
  } | null>(null);

  const showListed = (result: ListAnswer) => {
    if (result._tag === "Success") {
      setListed(result.value);
      setHidden(false);
      setError(null);
      return;
    }
    if (isForbidden(result)) {
      setHidden(true);
      return;
    }
    setError(
      errorMessageOf(squashAtomCommandFailure(result), "Could not read the configurations."),
    );
  };
  const applyListed = useEffectEvent(showListed);
  const loadFirst = useEffectEvent((target: EnvironmentId, space: SpaceId) =>
    commands.list({ environmentId: target, input: { spaceId: space } }),
  );
  const load = async () => showListed(await commands.list({ environmentId, input: { spaceId } }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Space's Makita configurations from the Hub when the section opens.
  useEffect(() => {
    let cancelled = false;
    void loadFirst(environmentId, spaceId).then((result) => {
      if (!cancelled) applyListed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, spaceId]);

  const act = async (run: typeof commands.pause, config: MakitaConfig, fallback: string) => {
    setPending(true);
    const result = await run({ environmentId, input: { configId: config.configId } });
    setPending(false);
    if (result._tag === "Success") await load();
    else setError(errorMessageOf(squashAtomCommandFailure(result), fallback));
  };

  const options = listed?.space ?? null;
  return (
    <SettingsSection
      id="makita"
      title="Makita"
      titleAction={
        <InfoTip label="About Makita configurations">
          Makita is this Hub's GitHub teammate. A configuration says which repositories it listens
          to, whom it answers, which of your AI accounts it spends and what it may do. When an
          allowed person labels an issue, assigns it to Makita or mentions Makita, Makita analyses
          it in a Thread of yours and answers on GitHub.
        </InfoTip>
      }
      headerAction={
        <div className="flex items-center gap-1">
          {listed === null || listed.configs.length === 0 ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                setShowing({ input: { spaceId }, title: "Every configuration in this Space." })
              }
            >
              Activity
            </Button>
          )}
          {options?.canCreate === true ? (
            <Button size="xs" onClick={() => setEditing("new")}>
              <PlusIcon />
              New configuration
            </Button>
          ) : null}
        </div>
      }
    >
      {error === null ? null : (
        <p className="px-4 py-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {notes.length === 0 ? null : (
        <ul className="flex flex-col gap-1 px-4 py-3" aria-label="Notes">
          {notes.map((note) => (
            <li key={note} className="text-xs text-warning-foreground">
              {note}
            </li>
          ))}
        </ul>
      )}
      {hidden ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{NOT_ALLOWED}</p>
      ) : listed === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {options !== null && options.canCreate && !options.accountReady ? (
            <p className="px-4 py-3 text-xs text-warning-foreground">
              Makita's GitHub account is not registered yet: the Owner registers it in Platform →
              Makita.
            </p>
          ) : null}
          {listed.configs.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {options?.canCreate === true
                ? "No configuration yet."
                : `No configuration yet. ${NOT_ALLOWED}`}
            </p>
          ) : (
            <ul aria-label="Makita configurations" className="divide-y divide-border/50">
              {listed.configs.map((config) => (
                <ConfigRow
                  key={config.configId}
                  config={config}
                  today={todayOf.get(config.configId) ?? null}
                  onActivity={() =>
                    setShowing({ input: { configId: config.configId }, title: config.name })
                  }
                  disabled={pending}
                  onEdit={
                    config.canEdit && options?.canCreate === true ? () => setEditing(config) : null
                  }
                  onPause={
                    config.canPause
                      ? () => void act(commands.pause, config, "Could not pause it.")
                      : null
                  }
                  onResume={
                    config.canResume
                      ? () => void act(commands.resume, config, "Could not resume it.")
                      : null
                  }
                  onDelete={config.canDelete ? () => setDeleting(config) : null}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {showing === null ? null : (
        <MakitaActivityDialog
          environmentId={environmentId}
          input={showing.input}
          title={showing.title}
          onClose={() => setShowing(null)}
        />
      )}
      {editing === null || options === null ? null : (
        <ConfigDialog
          spaceId={spaceId}
          options={options}
          config={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (input, configId) => {
            const result =
              configId === null
                ? await commands.create({ environmentId, input })
                : await commands.update({
                    environmentId,
                    input: { ...stripSpace(input), configId },
                  });
            if (result._tag === "Success") {
              const saved: MakitaConfigSaveResult = result.value;
              setNotes(saved.notes);
              setEditing(null);
              await load();
              return null;
            }
            return errorMessageOf(squashAtomCommandFailure(result), "Could not save it.");
          }}
        />
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete «{deleting?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Makita stops listening to its repositories and its running work stops. Its Threads
              stay in the Space. To only stop it for a while, pause it instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={pending}
              render={<Button variant="outline" disabled={pending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending || deleting === null}
              onClick={() => {
                if (deleting === null) return;
                void act(commands.remove, deleting, "Could not delete it.").then(() =>
                  setDeleting(null),
                );
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

const stripSpace = ({ spaceId: _spaceId, ...rest }: MakitaConfigInput) => rest;

/** One configuration, dense: its name and state; repositories; whom it answers; what it spends. */
function ConfigRow(props: {
  readonly config: MakitaConfig;
  /** Today's usage; null while unknown or not the viewer's to see. */
  readonly today: MakitaUsage | null;
  readonly onActivity: () => void;
  readonly disabled: boolean;
  readonly onEdit: (() => void) | null;
  readonly onPause: (() => void) | null;
  readonly onResume: (() => void) | null;
  readonly onDelete: (() => void) | null;
}) {
  const { config } = props;
  const repos = config.projects
    .filter((project) => project.repo !== null)
    .map((project) => project.repo);
  return (
    <li
      aria-label={config.name}
      className="flex flex-col gap-2 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-4 sm:px-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{config.name}</span>
          {config.pausedAt === null ? (
            <Badge variant="success" size="sm">
              Listening
            </Badge>
          ) : (
            <Badge variant="warning" size="sm">
              Paused
            </Badge>
          )}
          <Badge variant="secondary" size="sm">
            {config.capability === "push" ? "Also pushes branches" : "Comment and analyse"}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          {"all" in config.repos ? "All Projects with a GitHub remote" : "Repositories"}
          {": "}
          {repos.length === 0 ? "none" : repos.join(", ")}
        </span>
        <span className="text-xs text-muted-foreground">
          {`${triggersText(config.triggers)} · answers ${callersText(config)}`}
        </span>
        {config.capability === "push" ? (
          <span className="text-xs text-muted-foreground">{approvalText(config)}</span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {`${config.aiAccountName ?? "An AI account that no longer exists"} · ${config.modelSelection.model}${config.baseBranch === null ? "" : ` · base ${config.baseBranch}`} · Space Sandbox`}
        </span>
        <span className="text-xs text-muted-foreground">
          {`By ${config.createdByName ?? config.createdBy}`}
          {props.today === null ? "" : ` · Today: ${makitaUsageText(props.today)}`}
          {config.pausedAt === null
            ? ""
            : ` · ${config.pausedReason === null ? "paused" : PAUSE_REASONS[config.pausedReason]}${config.pausedByName === null ? "" : ` (${config.pausedByName}`}${config.pausedByName === null ? "" : `, ${formatWhen(config.pausedAt)})`}`}
        </span>
        {config.warnings.map((warning) => (
          <span key={warning} className="text-xs text-warning-foreground">
            {WARNINGS[warning]}
          </span>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Activity of ${config.name}`}
          onClick={props.onActivity}
        >
          Activity
        </Button>
        {props.onPause === null ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            aria-label={`Stop ${config.name} now`}
            title="Stops its running work too. Makita writes nothing on GitHub about it."
            onClick={props.onPause}
          >
            Stop now
          </Button>
        )}
        {props.onResume === null ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            aria-label={`Resume ${config.name}`}
            onClick={props.onResume}
          >
            Resume
          </Button>
        )}
        {props.onEdit === null && props.onDelete === null ? null : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={`Actions for ${config.name}`}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end" sideOffset={6}>
              {props.onEdit === null ? null : (
                <MenuItem aria-label={`Edit ${config.name}`} onClick={props.onEdit}>
                  Edit…
                </MenuItem>
              )}
              {props.onDelete === null ? null : (
                <MenuItem
                  aria-label={`Delete ${config.name}`}
                  variant="destructive"
                  onClick={props.onDelete}
                >
                  Delete…
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        )}
      </div>
    </li>
  );
}

/** Whom a configuration answers, in the list's words (ticket 08: its creator or the Members). */
const callersText = (config: MakitaConfig) =>
  config.callersMode === "creator"
    ? `only ${config.createdByName ?? "its creator"}`
    : config.callersMode === "members"
      ? "Members with a linked GitHub account"
      : config.callers.map((caller) => `@${caller.login}`).join(", ");

/** When its pushes wait, and who approves them (ticket 11). */
const approvalText = (config: MakitaConfig) => {
  if (config.approval === "never") return "Pushes without approval";
  const who = [
    config.createdByName ?? "its creator",
    ...config.approvers.map((approver) => `@${approver.login}`),
  ].join(", ");
  return `${config.approval === "always" ? "Every push waits" : "Pushes for others wait"} for /makita ok from ${who}`;
};

type CallersChoice = "creator" | "list" | "members";

/** When a push waits for an approver (Makita ticket 11). */
const APPROVAL_NOTES: Readonly<Record<MakitaConfig["approval"], string>> = {
  others:
    "A push after a request from someone who is not an approver waits for /makita ok. A push that fixes CI follows the last approval.",
  always:
    "Every push after a new request waits for /makita ok, even yours. A push that fixes CI follows the last approval.",
  never: "It pushes for anyone it answers without asking.",
};

/** «New configuration» or «Edit»: batch 1's choices, the rest said as coming later. */
function ConfigDialog(props: {
  readonly spaceId: SpaceId;
  readonly options: Options;
  readonly config: MakitaConfig | null;
  readonly onClose: () => void;
  readonly onSave: (input: MakitaConfigInput, configId: string | null) => Promise<string | null>;
}) {
  const { options, config } = props;
  const [name, setName] = useState(config?.name ?? "");
  const [allRepos, setAllRepos] = useState(config === null ? false : "all" in config.repos);
  const [chosen, setChosen] = useState<ReadonlyArray<ProjectId>>(
    config !== null && "projects" in config.repos ? config.repos.projects : [],
  );
  const [label, setLabel] = useState(
    config === null ? MAKITA_DEFAULT_LABEL : (config.triggers.label ?? ""),
  );
  const [assigned, setAssigned] = useState(config?.triggers.assigned ?? false);
  const [mention, setMention] = useState(config?.triggers.mention ?? false);
  const [callersMode, setCallersMode] = useState<CallersChoice>(
    config?.callersMode === "creator" || config?.callersMode === "members"
      ? config.callersMode
      : "list",
  );
  const [callers, setCallers] = useState(
    config?.callers.map((caller) => caller.login).join(", ") ?? "",
  );
  const [agent, setAgent] = useState<string>(
    config?.modelSelection.instanceId ?? options.agents[0]?.instanceId ?? "claudeAgent",
  );
  const [accountId, setAccountId] = useState<string>(
    config?.modelSelection.aiAccountId ?? options.aiAccounts[0]?.id ?? "",
  );
  const account = options.aiAccounts.find((entry) => entry.id === accountId) ?? null;
  const [model, setModel] = useState(config?.modelSelection.model ?? account?.models?.[0] ?? "");
  const [baseBranch, setBaseBranch] = useState(config?.baseBranch ?? "");
  const [capability, setCapability] = useState<"comment" | "push">(config?.capability ?? "comment");
  const [approval, setApproval] = useState<MakitaConfig["approval"]>(config?.approval ?? "others");
  const [approvers, setApprovers] = useState(
    config?.approvers.map((approver) => approver.login).join(", ") ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginsOf = (text: string) =>
    text
      .split(/[\s,]+/u)
      .map((login) => login.trim())
      .filter((login) => login.length > 0);
  const logins = loginsOf(callers);
  const ready =
    name.trim().length > 0 &&
    (allRepos || chosen.length > 0) &&
    (label.trim().length > 0 || assigned || mention) &&
    (callersMode !== "list" || logins.length > 0) &&
    account !== null &&
    model.trim().length > 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <form
          aria-label={config === null ? "New Makita configuration" : `Edit ${config.name}`}
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || account === null) return;
            setPending(true);
            setError(null);
            void props
              .onSave(
                {
                  spaceId: props.spaceId,
                  name: name.trim(),
                  repos: allRepos ? { all: true } : { projects: chosen },
                  triggers: {
                    label: label.trim().length === 0 ? null : label.trim(),
                    assigned,
                    mention,
                  },
                  callersMode,
                  callers: callersMode === "list" ? logins : [],
                  strangers: "ignore",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make(agent),
                    model: model.trim(),
                    aiAccountId: account.id as AiAccountId,
                  },
                  capability,
                  mayLand: false,
                  approval,
                  approvers: loginsOf(approvers),
                  baseBranch: baseBranch.trim().length === 0 ? null : baseBranch.trim(),
                  environmentId: null,
                },
                config?.configId ?? null,
              )
              .then(setError)
              .finally(() => setPending(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {config === null ? "New Makita configuration" : "Edit configuration"}
            </DialogTitle>
            <DialogDescription>
              Makita runs as you, in a Thread of yours, with the AI account you choose. It answers
              only the people you choose.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Name
                <Input
                  aria-label="Name"
                  nativeInput
                  maxLength={80}
                  disabled={pending}
                  placeholder="Widget bugs"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
              <div className="flex flex-col gap-2 text-xs font-medium">
                Repositories
                <ToggleGroup
                  aria-label="Repositories"
                  size="sm"
                  value={[allRepos ? "all" : "some"]}
                  onValueChange={(next) => setAllRepos(next[0] === "all")}
                >
                  <Toggle value="some">These Projects</Toggle>
                  <Toggle value="all">All Projects with a GitHub remote</Toggle>
                </ToggleGroup>
                {allRepos ? (
                  <p className="font-normal text-muted-foreground">
                    Now and the ones added later. Projects without a GitHub remote do not count.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1 font-normal" aria-label="Projects">
                    {options.projects.length === 0 ? (
                      <li className="text-muted-foreground">No Project in this Space.</li>
                    ) : null}
                    {options.projects.map((project) => {
                      const usable = project.state === "ok";
                      return (
                        <li key={project.projectId}>
                          <label className="flex items-center gap-2">
                            <Checkbox
                              aria-label={project.title ?? project.projectId}
                              disabled={pending || !usable}
                              checked={chosen.includes(project.projectId)}
                              onCheckedChange={(checked) =>
                                setChosen((current) =>
                                  checked === true
                                    ? [...current, project.projectId]
                                    : current.filter((id) => id !== project.projectId),
                                )
                              }
                            />
                            <span>{project.title ?? project.projectId}</span>
                            <span className="text-muted-foreground">
                              {project.state === "ok"
                                ? project.repo
                                : project.state === "ambiguous"
                                  ? "Pick the GitHub remote (gh repo set-default in its checkout)"
                                  : "No GitHub remote"}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Label that hands an issue to Makita
                  <Input
                    aria-label="Label"
                    nativeInput
                    maxLength={50}
                    disabled={pending}
                    value={label}
                    onChange={(event) => setLabel(event.currentTarget.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Base branch for its pull requests
                  <Input
                    aria-label="Base branch"
                    nativeInput
                    disabled={pending}
                    placeholder="The repository's default branch"
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div className="flex flex-col gap-1 text-xs font-medium">
                Also hands an issue to Makita
                <label className="flex items-center gap-2 font-normal">
                  <Checkbox
                    aria-label="Assigning it to Makita"
                    disabled={pending}
                    checked={assigned}
                    onCheckedChange={(checked) => setAssigned(checked === true)}
                  />
                  Assigning it to Makita
                </label>
                <label className="flex items-center gap-2 font-normal">
                  <Checkbox
                    aria-label="Mentioning Makita"
                    disabled={pending}
                    checked={mention}
                    onCheckedChange={(checked) => setMention(checked === true)}
                  />
                  Mentioning Makita in a comment on an issue or a pull request
                </label>
                <p className="font-normal text-muted-foreground">
                  Leave the label empty to use only these. On an issue Makita already works on, a
                  mention by someone it answers continues that work, and «/makita stop» stops it.
                </p>
              </div>
              <div className="flex flex-col gap-2 text-xs font-medium">
                It answers
                <ToggleGroup
                  aria-label="It answers"
                  size="sm"
                  value={[callersMode]}
                  onValueChange={(next) => {
                    const choice = next[0];
                    if (choice === "creator" || choice === "list" || choice === "members") {
                      setCallersMode(choice);
                    }
                  }}
                >
                  <Toggle value="creator">Only me</Toggle>
                  <Toggle value="list">A list of GitHub users</Toggle>
                  <Toggle value="members">
                    Members of this Space with a linked GitHub account
                  </Toggle>
                </ToggleGroup>
                {callersMode === "list" ? (
                  <Input
                    aria-label="GitHub users it answers"
                    nativeInput
                    disabled={pending}
                    placeholder="octocat, another-login"
                    value={callers}
                    onChange={(event) => setCallers(event.currentTarget.value)}
                  />
                ) : null}
                <span className="font-normal text-muted-foreground">
                  {callersMode === "list"
                    ? "Your own linked GitHub account counts too. Others are ignored; answering anyone comes later."
                    : callersMode === "creator"
                      ? "Your GitHub account as linked in User settings → Account. Link it there first."
                      : "Admins and Members of this Space who linked their GitHub account in User settings → Account, read at each event: whoever leaves the Space or unlinks stops counting at once. Guests do not count."}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Agent
                  <Select
                    value={agent}
                    disabled={pending}
                    onValueChange={(next) => setAgent(String(next ?? agent))}
                  >
                    <SelectTrigger aria-label="Agent">
                      <SelectValue>
                        {options.agents.find((entry) => entry.instanceId === agent)?.label ?? agent}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {options.agents.map((entry) => (
                        <SelectItem key={entry.instanceId} value={entry.instanceId}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  AI account
                  <Select
                    value={accountId}
                    disabled={pending}
                    onValueChange={(next) => {
                      const id = String(next ?? "");
                      setAccountId(id);
                      const models = options.aiAccounts.find((entry) => entry.id === id)?.models;
                      if (models !== undefined && models !== null && !models.includes(model)) {
                        setModel(models[0] ?? "");
                      }
                    }}
                  >
                    <SelectTrigger aria-label="AI account">
                      <SelectValue>{account?.name ?? "Choose an AI account"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {options.aiAccounts.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Model
                  {account?.models === null || account === null ? (
                    <Input
                      aria-label="Model"
                      nativeInput
                      disabled={pending}
                      value={model}
                      onChange={(event) => setModel(event.currentTarget.value)}
                    />
                  ) : (
                    <Select
                      value={model}
                      disabled={pending}
                      onValueChange={(next) => setModel(String(next ?? model))}
                    >
                      <SelectTrigger aria-label="Model">
                        <SelectValue>{model.length === 0 ? "Choose a model" : model}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {account.models.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {entry}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                </label>
              </div>
              {options.aiAccounts.length === 0 ? (
                <p className="text-xs text-warning-foreground">
                  No AI account that goes through the Hub's AI gateway is available to you here.
                </p>
              ) : null}
              <div className="flex flex-col gap-2 text-xs font-medium">
                What it may do
                <ToggleGroup
                  aria-label="What it may do"
                  size="sm"
                  value={[capability]}
                  onValueChange={(next) => setCapability(next[0] === "push" ? "push" : "comment")}
                >
                  <Toggle value="comment">Comment and analyse</Toggle>
                  <Toggle value="push">Also push branches</Toggle>
                </ToggleGroup>
                {capability === "push" ? (
                  <>
                    <p className="font-normal text-muted-foreground">
                      Makita commits in its own worktree and the Hub pushes them to a makita/…
                      branch, never to the base or the default branch, never forced, never changing
                      workflows. Opening pull requests comes later.
                    </p>
                    <ToggleGroup
                      aria-label="Approval before pushing"
                      size="sm"
                      value={[approval]}
                      onValueChange={(next) => {
                        const choice = next[0];
                        if (choice === "others" || choice === "always" || choice === "never") {
                          setApproval(choice);
                        }
                      }}
                    >
                      <Toggle value="others">When someone else asks</Toggle>
                      <Toggle value="always">Always</Toggle>
                      <Toggle value="never">Never</Toggle>
                    </ToggleGroup>
                    <p className="font-normal text-muted-foreground">{APPROVAL_NOTES[approval]}</p>
                    {approval === "never" ? null : (
                      <>
                        <Input
                          aria-label="Other approvers"
                          nativeInput
                          disabled={pending}
                          placeholder="Other approvers: octocat, another-login"
                          value={approvers}
                          onChange={(event) => setApprovers(event.currentTarget.value)}
                        />
                        <p className="font-normal text-muted-foreground">
                          You approve with your linked GitHub account. Someone listed here counts
                          only while the account is linked by an active Admin or Member of this
                          Space, checked at each /makita ok. Makita asks on the issue, and an
                          approver replies with a new comment whose first line is /makita ok.
                        </p>
                      </>
                    )}
                  </>
                ) : null}
                <span className="font-normal text-muted-foreground">{CI_NOTE}</span>
              </div>
              <div className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Where it works</span>
                <span>Space Sandbox (recommended)</span>
              </div>
              {error === null ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => props.onClose()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !ready}>
              {pending ? "Saving…" : config === null ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

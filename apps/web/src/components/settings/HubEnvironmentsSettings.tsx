import {
  environmentUseDescription,
  shownEnvironmentStatus,
  uploadIssueText,
} from "@t3tools/client-runtime/environment/hub-environments";
import { type HubEnvironmentSummary, isListedMachine, type SpaceId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { usePrimaryActsForInstallation, usePrimarySessionState } from "../../environments/primary";
import {
  changeHubEnvironmentMode,
  fetchHubEnvironments,
  removeHubEnvironment,
  renameHubEnvironment,
} from "../../environments/primary/hubEnvironments";
import { errorMessageOf } from "../../lib/errorMessage";
import { cn } from "../../lib/utils";
import { useCurrentSpace } from "../../state/currentSpace";
import { useProjects } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { grantsEnvironment } from "../../state/grants";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentStatusBadge } from "../EnvironmentStatusDot";
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
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { peekKeycloakStepUp } from "../auth/keycloakStepUp";
import { LendMachineDialog } from "./GrantsSettings";
import { machineInScope, sandboxOfScope, type OwnedResourceScope } from "./ownedResourceScope";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SshInstallDialog } from "./SshInstallDialog";
import { UsedBySelect } from "./UsedBySelect";

// The list's status is computed on the Hub from heartbeats; polling keeps it current while open.
const REFRESH_MS = 5_000;

const gigabytes = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

/** A store's share in use, and «12.3 of 25.2 GB used»: what fills up is what the bar shows. */
const usedOf = (totalBytes: number, availableBytes: number) => {
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    used: totalBytes > 0 ? usedBytes / totalBytes : null,
    detail: `${(usedBytes / 1_000_000_000).toFixed(1)} of ${gigabytes(totalBytes)} used`,
  };
};

/** One labelled resource: its name, a thin bar with its percent, and what the bar measures. */
function ResourceMeter(props: {
  readonly label: string;
  /** The share in use, 0 to 1; null when the machine does not say. */
  readonly used: number | null;
  readonly detail: string;
  /** What a screen reader says for the bar; the detail when absent. */
  readonly valueText?: string;
}) {
  const percent =
    props.used === null ? null : Math.min(100, Math.max(0, Math.round(props.used * 100)));
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">{props.label}</span>
        {percent === null ? null : <span className="tabular-nums">{percent}%</span>}
      </span>
      {percent === null ? (
        <span aria-hidden="true" className="block h-1 rounded-full bg-muted" />
      ) : (
        <span
          role="meter"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={props.valueText ?? props.detail}
          className="block h-1 overflow-hidden rounded-full bg-muted"
        >
          <span
            className={cn(
              "block h-full rounded-full",
              percent >= 90 ? "bg-warning" : "bg-muted-foreground/70",
            )}
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
      <span className="tabular-nums">{props.detail}</span>
    </span>
  );
}

function describe(
  environment: HubEnvironmentSummary,
  viewer: { readonly userId: string | undefined; readonly isOwner: boolean },
  spaceName: (spaceId: string | null | undefined) => string | null,
  projectName: (projectId: string) => string | null,
  lentTo = 0,
) {
  const parts = [
    environmentUseDescription(environment, {
      spaceName: spaceName(environment.spaceId),
      viewerUserId: viewer.userId,
    }),
    environment.os,
    lentTo === 0 ? null : `Lent to ${lentTo} ${lentTo === 1 ? "Space" : "Spaces"}`,
    environment.lastSeenAt === null
      ? "never connected"
      : environment.kind === "hub"
        ? null
        : `last seen ${new Date(environment.lastSeenAt).toLocaleString()}`,
    // The Hub machine's Threads are everyone's: only the Owner gets that count.
    environment.kind === "hub" && !viewer.isOwner
      ? null
      : `${environment.runningThreadCount} running Threads`,
  ];
  const resources = environment.resources;
  const providers = environment.providers
    .filter((provider) => provider.installed)
    .map((provider) =>
      provider.version === null
        ? provider.instanceId
        : `${provider.instanceId} ${provider.version}`,
    );
  return (
    <>
      {parts.filter((part) => part !== null).join(" · ")}
      {resources !== null ? (
        // Three labelled meters, each «used of total»: memory and disk never read as one figure.
        <span className="mt-2 grid max-w-lg grid-cols-3 gap-4" role="group" aria-label="Resources">
          <ResourceMeter
            label="CPU"
            used={resources.hostResources.cpuUtilization}
            detail={`${resources.hostResources.cpuCount} CPUs`}
            valueText={`${resources.hostResources.cpuCount} CPUs, ${Math.round(
              (resources.hostResources.cpuUtilization ?? 0) * 100,
            )}% busy`}
          />
          <ResourceMeter
            label="Memory"
            {...usedOf(
              resources.hostResources.totalMemoryBytes,
              resources.hostResources.availableMemoryBytes,
            )}
          />
          {resources.disk === null ? null : (
            <ResourceMeter
              label="Disk"
              {...usedOf(resources.disk.totalBytes, resources.disk.availableBytes)}
            />
          )}
        </span>
      ) : null}
      {providers.length > 0 ? (
        <span className="mt-2 block">{`Providers: ${providers.join(", ")}`}</span>
      ) : null}
      {(environment.uploadIssues ?? []).map((issue) => (
        <span
          key={`${issue.projectId}:${issue.threadId ?? ""}`}
          className="mt-1 block text-warning-foreground"
          data-upload-issue={issue.kind}
        >
          {uploadIssueText(issue, projectName(issue.projectId))}
          {issue.nextAttemptAt === null
            ? null
            : ` Tries again at ${new Date(issue.nextAttemptAt).toLocaleTimeString()}.`}
        </span>
      ))}
    </>
  );
}

/**
 * Settings → Environments: the machines joined to this Hub. The Owner sees and manages every one;
 * each User sees the Hub machine, their own personal machines (which they rename, remove and
 * dedicate to an Organization they run) and the machines dedicated to their Spaces, which an
 * Admin of that Organization renames, removes and moves to another they run (owned-resources 07).
 */
export function HubEnvironmentsSettings({ scope }: { readonly scope?: OwnedResourceScope }) {
  const session = usePrimarySessionState();
  // Opening a machine's page takes whoever acts for the Installation; the others read the list.
  const canOpen = usePrimaryActsForInstallation();
  const signedIn = session.data?.authenticated === true;
  const isOwner = signedIn && session.data?.isOwner === true;
  const projects = useProjects();
  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.title ?? null;
  // Optional in the session: a session from before the Installation had an Owner names no User.
  const userId = signedIn ? session.data?.userId : undefined;
  // A machine lent to a Space is its lender's: nobody here renames, removes or rededicates it.
  // The Hub says what this viewer may do; an older Hub, the Owner or a machine's own User.
  const manages = (environment: HubEnvironmentSummary) =>
    environment.lent === undefined &&
    (environment.canManage ??
      (isOwner ||
        (userId !== undefined &&
          environment.kind === "external" &&
          environment.ownerUserId === userId)));
  // Changing who uses it takes its owner (a personal machine), or someone who runs its
  // Organization (a dedicated one); where it goes, the server checks again.
  const changesUse = (environment: HubEnvironmentSummary) =>
    environment.kind === "external" &&
    environment.lent === undefined &&
    (environment.mode === "dedicated"
      ? manages(environment)
      : userId !== undefined && environment.ownerUserId === userId);
  // Only its owner lends a personal machine (Grants).
  const lends = (environment: HubEnvironmentSummary) =>
    userId !== undefined &&
    environment.kind === "external" &&
    environment.mode === "personal" &&
    environment.ownerUserId === userId;
  // Back from «Confirm with Keycloak», the Lend dialog it left opens again to finish.
  const [lending, setLending] = useState<Pick<HubEnvironmentSummary, "id" | "name"> | undefined>(
    () => peekKeycloakStepUp("lend-machine")?.machine,
  );
  // One machine may be lent to several Spaces, a Sandbox each: how many, by machine.
  const primaryId = usePrimaryEnvironmentId();
  const connected = useEnvironment(primaryId)?.connection.phase === "connected";
  const listGiven = useAtomCommand(grantsEnvironment.listGiven, "list your loans");
  const [lentCounts, setLentCounts] = useState<Readonly<Record<string, number>>>({});
  const loadLent = useEffectEvent((target: NonNullable<typeof primaryId>) =>
    listGiven({ environmentId: target, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads how many Spaces borrow each machine; again when the Lend dialog closes.
  useEffect(() => {
    if (primaryId === null || !connected || lending !== undefined) return;
    let current = true;
    void loadLent(primaryId).then((result) => {
      if (!current || result._tag !== "Success") return;
      const counts: Record<string, number> = {};
      for (const grant of result.value.grants) {
        if (grant.resource.kind !== "environment") continue;
        if (grant.state !== "pending" && grant.state !== "active") continue;
        counts[grant.resource.id] = (counts[grant.resource.id] ?? 0) + 1;
      }
      setLentCounts(counts);
    });
    return () => {
      current = false;
    };
  }, [primaryId, connected, lending]);
  const [environments, setEnvironments] = useState<ReadonlyArray<HubEnvironmentSummary> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly name: string }>();
  const [removing, setRemoving] = useState<HubEnvironmentSummary>();
  // The machine whose mode the Owner changes, and to what: "personal" or an Organization.
  const [changingMode, setChangingMode] = useState<{
    readonly environment: HubEnvironmentSummary;
    readonly use: "personal" | SpaceId;
  }>();
  const [modeError, setModeError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [addingOverSsh, setAddingOverSsh] = useState(false);
  const spaces = useCurrentSpace((state) => state.view?.spaces);
  // The Organizations this viewer dedicates machines to: every one for the Owner, those they run
  // (as a full Admin) for anyone else.
  const organizations = (spaces ?? []).filter(
    (space) =>
      space.kind === "organization" &&
      space.archived !== true &&
      (isOwner || (space.role === "admin" && space.pendingAdmin !== true)) &&
      // A Space's section dedicates only to that Space.
      (scope?.kind !== "organization" || space.id === scope.spaceId),
  );
  // A Space by name, or null when this viewer has none for it; callers say what to show instead.
  const spaceName = (spaceId: string | null | undefined) =>
    spaces?.find((space) => space.id === spaceId)?.name ?? null;
  // A dedicated machine leaving its Space loses that Space's work files on it.
  const leavesSpace = (change: {
    readonly environment: HubEnvironmentSummary;
    readonly use: "personal" | SpaceId;
  }) => change.environment.mode === "dedicated" && change.use !== change.environment.spaceId;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the Hub for each machine's live status while Settings is open.
  useEffect(() => {
    if (!signedIn) return;
    let current = true;
    const load = () =>
      void fetchHubEnvironments().then(
        (list) => {
          if (!current) return;
          setEnvironments(list.environments);
          setError(null);
        },
        (cause: unknown) => {
          if (current) setError(errorMessageOf(cause, "Could not load this Hub's Environments."));
        },
      );
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [signedIn]);

  if (!signedIn) return null;

  const run = async (change: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await change();
      setRenaming(undefined);
      setRemoving(undefined);
    } catch (cause) {
      setError(errorMessageOf(cause, "That change did not go through."));
    }
    setPending(false);
  };

  const machinePage = (environment: HubEnvironmentSummary) =>
    scope?.kind === "user" ? (
      <Button
        aria-label={`Open ${environment.name}`}
        size="xs"
        variant="outline"
        render={
          <Link
            to="/settings/user/machines/$environmentId/$machineSection"
            params={{ environmentId: environment.id, machineSection: "providers" }}
          />
        }
      >
        Open
      </Button>
    ) : scope?.kind === "organization" ? (
      <Button
        aria-label={`Open ${environment.name}`}
        size="xs"
        variant="outline"
        render={
          <Link
            to="/settings/space/$spaceId/machines/$environmentId/$machineSection"
            params={{
              spaceId: scope.spaceId,
              environmentId: environment.id,
              machineSection: "providers",
            }}
          />
        }
      >
        Open
      </Button>
    ) : null;
  const sandbox = sandboxOfScope(scope ?? { kind: "user" }, environments ?? []);

  return (
    <>
      {scope?.kind === "organization" ? (
        <SettingsSection id="space-sandbox" title="Sandbox">
          {environments === null && error === null ? <SettingsRow title="Loading…" /> : null}
          {sandbox === undefined ? (
            environments === null ? null : (
              <SettingsRow
                title="No Sandbox yet"
                description="This Space's Sandbox starts with its first Thread there."
              />
            )
          ) : (
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  {sandbox.name}
                  <EnvironmentStatusBadge
                    status={shownEnvironmentStatus(sandbox)}
                    kind={sandbox.kind}
                  />
                </span>
              }
              description={
                <>
                  {describe(sandbox, { userId, isOwner }, spaceName, projectName)}
                  {sandbox.startError ? (
                    <>
                      <br />
                      {`Its last start failed: ${sandbox.startError}`}
                    </>
                  ) : null}
                </>
              }
            />
          )}
          {isOwner ? (
            <SettingsRow
              title="All Sandboxes"
              description="The Hub's full list of Sandboxes, with their limits and image, is under Platform."
              control={
                <Button
                  size="xs"
                  variant="outline"
                  render={
                    <Link to="/settings/platform/$section" params={{ section: "sandboxes" }} />
                  }
                >
                  Open Platform → Sandboxes
                </Button>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}
      <SettingsSection
        id="hub-environments"
        title={
          scope?.kind === "user"
            ? "Your machines"
            : scope?.kind === "organization"
              ? "Machines of this Space"
              : "Machines on this Hub"
        }
      >
        {environments === null && error === null ? <SettingsRow title="Loading…" /> : null}
        {(environments ?? [])
          // A Space's Sandbox is listed once it has run; until then it is only a choice in the composer.
          .filter(isListedMachine)
          .filter(
            (environment) => scope === undefined || machineInScope(scope, environment, userId),
          )
          .map((environment) => {
            return (
              <SettingsRow
                key={environment.id}
                title={
                  <span className="flex items-center gap-2">
                    {environment.name}
                    <EnvironmentStatusBadge
                      status={shownEnvironmentStatus(environment)}
                      kind={environment.kind}
                    />
                  </span>
                }
                description={describe(
                  environment,
                  { userId, isOwner },
                  spaceName,
                  projectName,
                  lentCounts[environment.id] ?? 0,
                )}
                control={
                  (canOpen && scope !== undefined) ||
                  (manages(environment) && environment.kind !== "sandbox") ? (
                    <div className="flex items-center gap-1">
                      {canOpen ? machinePage(environment) : null}
                      {/* What changes the machine sits in its «⋯» menu, each as before. */}
                      {manages(environment) && environment.kind !== "sandbox" ? (
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                aria-label={`Actions for ${environment.name}`}
                                size="icon-xs"
                                type="button"
                                variant="ghost"
                              />
                            }
                          >
                            <EllipsisIcon />
                          </MenuTrigger>
                          <MenuPopup align="end" sideOffset={6}>
                            {lends(environment) ? (
                              <MenuItem
                                aria-label={`Lend ${environment.name} to another Space`}
                                onClick={() => setLending(environment)}
                              >
                                Lend…
                              </MenuItem>
                            ) : null}
                            {changesUse(environment) ? (
                              <MenuItem
                                aria-label={`Change who uses ${environment.name}`}
                                onClick={() => {
                                  setModeError(null);
                                  setChangingMode({
                                    environment,
                                    use:
                                      environment.mode === "dedicated" && environment.spaceId
                                        ? environment.spaceId
                                        : "personal",
                                  });
                                }}
                              >
                                Change use…
                              </MenuItem>
                            ) : null}
                            <MenuItem
                              aria-label={`Rename ${environment.name}`}
                              onClick={() =>
                                setRenaming({ id: environment.id, name: environment.name })
                              }
                            >
                              Rename…
                            </MenuItem>
                            {environment.kind === "external" ? (
                              <MenuItem
                                aria-label={`Remove ${environment.name}`}
                                variant="destructive"
                                onClick={() => setRemoving(environment)}
                              >
                                Remove…
                              </MenuItem>
                            ) : null}
                          </MenuPopup>
                        </Menu>
                      ) : null}
                    </div>
                  ) : null
                }
              />
            );
          })}
        <SettingsRow
          title="Add a machine"
          description={
            scope?.kind === "user"
              ? "Run `t3 join <this Hub's address>` on it, then approve it here in the browser: it becomes your personal machine."
              : scope?.kind === "organization"
                ? "Run `t3 join --dedicated <Organization> <this Hub's address>` on it and approve it as an Admin of this Organization (or the Owner)."
                : "Run `t3 join <this Hub's address>` on it, then approve it here in the browser: it becomes your personal machine. For a machine all of an Organization uses, run `t3 join --dedicated <Organization> <this Hub's address>` and approve it as an Admin of that Organization (or the Owner)."
          }
        />
        {scope?.kind !== "user" && organizations.length > 0 ? (
          <SettingsRow
            title="Add a machine over SSH"
            description="Give the Hub a Linux machine's SSH address and key: it installs T3 Code there and dedicates it to an Organization, showing each step."
            control={
              <Button size="xs" variant="outline" onClick={() => setAddingOverSsh(true)}>
                Add over SSH
              </Button>
            }
          />
        ) : null}
        {addingOverSsh ? (
          <SshInstallDialog
            organizations={organizations}
            onClose={() => setAddingOverSsh(false)}
            onInstalled={() =>
              void fetchHubEnvironments().then(
                (list) => setEnvironments(list.environments),
                () => undefined,
              )
            }
          />
        ) : null}
        {error ? <SettingsRow title="Something went wrong" description={error} /> : null}
        {lending !== undefined ? (
          <LendMachineDialog machine={lending} onClose={() => setLending(undefined)} />
        ) : null}
        {renaming !== undefined ? (
          <Dialog open onOpenChange={(open) => (open ? undefined : setRenaming(undefined))}>
            <DialogPopup className="sm:max-w-sm">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const environment = environments?.find((entry) => entry.id === renaming.id);
                  if (environment === undefined) return;
                  void run(async () => {
                    const renamed = await renameHubEnvironment(
                      environment.id,
                      renaming.name.trim(),
                    );
                    setEnvironments(
                      (list) =>
                        list?.map((entry) => (entry.id === renamed.id ? renamed : entry)) ?? null,
                    );
                  });
                }}
              >
                <DialogHeader>
                  <DialogTitle>Rename environment</DialogTitle>
                </DialogHeader>
                <DialogPanel>
                  <label className="text-xs font-medium" htmlFor="hub-environment-name">
                    Name
                  </label>
                  <Input
                    id="hub-environment-name"
                    maxLength={64}
                    nativeInput
                    value={renaming.name}
                    onChange={(event) =>
                      setRenaming({ id: renaming.id, name: event.currentTarget.value })
                    }
                  />
                </DialogPanel>
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setRenaming(undefined)}>
                    Cancel
                  </Button>
                  <Button disabled={pending || renaming.name.trim() === ""} type="submit">
                    Save
                  </Button>
                </DialogFooter>
              </form>
            </DialogPopup>
          </Dialog>
        ) : null}
        {changingMode !== undefined ? (
          <Dialog open onOpenChange={(open) => (open ? undefined : setChangingMode(undefined))}>
            <DialogPopup className="sm:max-w-sm">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const { environment, use } = changingMode;
                  setPending(true);
                  setModeError(null);
                  void changeHubEnvironmentMode(
                    environment.id,
                    use === "personal" ? { mode: "personal" } : { mode: "dedicated", spaceId: use },
                  ).then(
                    (changed) => {
                      setEnvironments(
                        (list) =>
                          list?.map((entry) => (entry.id === changed.id ? changed : entry)) ?? null,
                      );
                      setChangingMode(undefined);
                      setPending(false);
                    },
                    (cause: unknown) => {
                      // A machine with Threads on it says which to move first.
                      setModeError(errorMessageOf(cause, "That change did not go through."));
                      setPending(false);
                    },
                  );
                }}
              >
                <DialogHeader>
                  <DialogTitle>{`Who uses ${changingMode.environment.name}`}</DialogTitle>
                  <DialogDescription>
                    A personal machine runs only its owner's work. One dedicated to an Organization
                    runs the work of everyone there, in a Sandbox container. It changes only once no
                    Thread is on it.
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel>
                  <label className="text-xs font-medium" htmlFor="hub-environment-use">
                    Used by
                  </label>
                  <div className="mt-1">
                    <UsedBySelect
                      disabled={pending}
                      id="hub-environment-use"
                      onChange={(use) =>
                        setChangingMode({ environment: changingMode.environment, use })
                      }
                      spaces={organizations}
                      value={changingMode.use}
                    />
                  </div>
                  {leavesSpace(changingMode) ? (
                    <p className="mt-2 text-sm text-warning-foreground">
                      {`Work files on ${changingMode.environment.name} for ${spaceName(changingMode.environment.spaceId) ?? "a Space"} will be deleted: its Sandbox's home goes, so no other Space or owner ever sees them.`}
                    </p>
                  ) : null}
                  {modeError !== null ? (
                    <p className="mt-2 text-sm text-destructive-foreground" role="alert">
                      {modeError}
                    </p>
                  ) : null}
                </DialogPanel>
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setChangingMode(undefined)}>
                    Cancel
                  </Button>
                  <Button disabled={pending} type="submit">
                    {leavesSpace(changingMode) ? "Change and delete its files" : "Save"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogPopup>
          </Dialog>
        ) : null}
        {removing !== undefined ? (
          <Dialog open onOpenChange={(open) => (open ? undefined : setRemoving(undefined))}>
            <DialogPopup className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>{`Remove ${removing.name}?`}</DialogTitle>
                <DialogDescription>
                  It disconnects now and its credential stops working. To add it again, run `t3
                  join` on it.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setRemoving(undefined)}>
                  Cancel
                </Button>
                <Button
                  disabled={pending}
                  variant="destructive"
                  onClick={() =>
                    void run(async () => {
                      const list = await removeHubEnvironment(removing.id);
                      setEnvironments(list.environments);
                    })
                  }
                >
                  Remove machine
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        ) : null}
      </SettingsSection>
    </>
  );
}

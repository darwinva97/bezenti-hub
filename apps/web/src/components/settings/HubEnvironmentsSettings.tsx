import {
  environmentUseDescription,
  shownEnvironmentStatus,
} from "@t3tools/client-runtime/environment/hub-environments";
import { type HubEnvironmentSummary, isListedMachine, type SpaceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  changeHubEnvironmentMode,
  fetchHubEnvironments,
  removeHubEnvironment,
  renameHubEnvironment,
} from "../../environments/primary/hubEnvironments";
import { errorMessageOf } from "../../lib/errorMessage";
import { useCurrentSpace } from "../../state/currentSpace";
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
import { LendMachineDialog } from "./GrantsSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SshInstallDialog } from "./SshInstallDialog";
import { UsedBySelect } from "./UsedBySelect";

// The list's status is computed on the Hub from heartbeats; polling keeps it current while open.
const REFRESH_MS = 5_000;

const gigabytes = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

function describe(
  environment: HubEnvironmentSummary,
  viewer: { readonly userId: string | undefined; readonly isOwner: boolean },
  spaceName: (spaceId: string | null | undefined) => string | null,
) {
  const parts = [
    environmentUseDescription(environment, {
      spaceName: spaceName(environment.spaceId),
      viewerUserId: viewer.userId,
    }),
    environment.os,
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
        <>
          <br />
          {`${resources.hostResources.cpuCount} CPUs${
            resources.hostResources.cpuUtilization === null
              ? ""
              : ` (${Math.round(resources.hostResources.cpuUtilization * 100)}% busy)`
          } · ${gigabytes(resources.hostResources.availableMemoryBytes)} of ${gigabytes(
            resources.hostResources.totalMemoryBytes,
          )} memory free${
            resources.disk === null
              ? ""
              : ` · ${gigabytes(resources.disk.availableBytes)} of ${gigabytes(resources.disk.totalBytes)} disk free`
          }`}
        </>
      ) : null}
      {providers.length > 0 ? (
        <>
          <br />
          {`Providers: ${providers.join(", ")}`}
        </>
      ) : null}
    </>
  );
}

/**
 * Settings → Environments: the machines joined to this Hub. The Owner sees and manages every one,
 * and dedicates machines to Organizations; each User sees the Hub machine, their own personal
 * machines (which they rename and remove) and the machines dedicated to their Spaces.
 */
export function HubEnvironmentsSettings() {
  const session = usePrimarySessionState();
  const signedIn = session.data?.authenticated === true;
  const isOwner = signedIn && session.data?.isOwner === true;
  // Optional in the session: a session from before the Installation had an Owner names no User.
  const userId = signedIn ? session.data?.userId : undefined;
  // A machine lent to a Space is its lender's: nobody here renames, removes or rededicates it.
  const manages = (environment: HubEnvironmentSummary) =>
    environment.lent === undefined &&
    (isOwner ||
      (userId !== undefined &&
        environment.kind === "external" &&
        environment.ownerUserId === userId));
  // Only its owner lends a personal machine (Grants).
  const lends = (environment: HubEnvironmentSummary) =>
    userId !== undefined &&
    environment.kind === "external" &&
    environment.mode === "personal" &&
    environment.ownerUserId === userId;
  const [lending, setLending] = useState<HubEnvironmentSummary>();
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
  const organizations = (spaces ?? []).filter(
    (space) => space.kind === "organization" && space.archived !== true,
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

  return (
    <SettingsSection id="hub-environments" title="Machines on this Hub">
      {environments === null && error === null ? <SettingsRow title="Loading…" /> : null}
      {(environments ?? [])
        // A Space's Sandbox is listed once it has run; until then it is only a choice in the composer.
        .filter(isListedMachine)
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
              description={describe(environment, { userId, isOwner }, spaceName)}
              control={
                manages(environment) && environment.kind !== "sandbox" ? (
                  <div className="flex gap-1">
                    {lends(environment) ? (
                      <Button
                        aria-label={`Lend ${environment.name} to another Space`}
                        size="xs"
                        variant="outline"
                        onClick={() => setLending(environment)}
                      >
                        Lend…
                      </Button>
                    ) : null}
                    {isOwner && environment.kind === "external" ? (
                      <Button
                        aria-label={`Change who uses ${environment.name}`}
                        size="xs"
                        variant="outline"
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
                        Change use
                      </Button>
                    ) : null}
                    <Button
                      aria-label={`Rename ${environment.name}`}
                      size="xs"
                      variant="outline"
                      onClick={() => setRenaming({ id: environment.id, name: environment.name })}
                    >
                      Rename
                    </Button>
                    {environment.kind === "external" ? (
                      <Button
                        aria-label={`Remove ${environment.name}`}
                        size="xs"
                        variant="destructive-outline"
                        onClick={() => setRemoving(environment)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ) : null
              }
            />
          );
        })}
      <SettingsRow
        title="Add a machine"
        description="Run `t3 join <this Hub's address>` on it, then approve it here in the browser. For a machine all of an Organization uses, run `t3 join --dedicated <Organization> <this Hub's address>` and approve it as the Owner."
      />
      {isOwner ? (
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
                  const renamed = await renameHubEnvironment(environment.id, renaming.name.trim());
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
                It disconnects now and its credential stops working. To add it again, run `t3 join`
                on it.
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
  );
}

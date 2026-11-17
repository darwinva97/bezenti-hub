import {
  fetchInstallationUsers,
  INSTALLATION_PERMISSION_LABELS,
  setInstallationPermission,
  setInstallationUserStatus,
} from "@t3tools/client-runtime/spaces/space-directory";
import type {
  InstallationPermission,
  InstallationUser,
  InstallationUserStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useId, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { loadSpaces, useCurrentSpace } from "../../state/currentSpace";
import { Badge } from "../ui/badge";
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
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

const PERMISSIONS: ReadonlyArray<InstallationPermission> = ["environments.registerOwn"];

const fetchUsers = () =>
  runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchInstallationUsers)));

/** What the Owner types to confirm a removal: the sign-in name, else the display name. */
const confirmationOf = (user: InstallationUser) => user.loginName ?? user.displayName;

/** The Owner's list of Users, with the Installation permissions each one holds. */
export function UsersDialog({ onClose }: { readonly onClose: () => void }) {
  const id = useId();
  const [users, setUsers] = useState<ReadonlyArray<InstallationUser> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ readonly userId: string; readonly typed: string }>();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Installation's Users from the server when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void fetchUsers().then(
      (list) => {
        if (!cancelled) setUsers(list.users);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the Users."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const replace = (updated: InstallationUser) => {
    setUsers((current) =>
      current === null
        ? current
        : current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
    );
    // The Owner's selector lists every Personal space; keep it in step with the change.
    const { environmentId } = useCurrentSpace.getState();
    if (environmentId !== null) void loadSpaces(environmentId);
  };

  const toggle = async (
    user: InstallationUser,
    permission: InstallationPermission,
    granted: boolean,
  ) => {
    setPending(`${user.id}:${permission}`);
    setError(null);
    try {
      replace(
        await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) =>
              setInstallationPermission(client, user.id, permission, granted),
            ),
          ),
        ),
      );
    } catch (cause) {
      setError(messageOf(cause, "Could not change the permission."));
    }
    setPending(null);
  };

  const changeStatus = async (user: InstallationUser, status: InstallationUserStatus) => {
    setPending(`${user.id}:status`);
    setError(null);
    try {
      replace(
        await runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) => setInstallationUserStatus(client, user.id, status)),
          ),
        ),
      );
      setRemoving(undefined);
    } catch (cause) {
      setError(messageOf(cause, "Could not change this User."));
    }
    setPending(null);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Users</DialogTitle>
          <DialogDescription>
            Installation permissions apply outside any Organization and take effect at once. You can
            always see every Personal space.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {users === null ? (
              error === null ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : null
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Users">
                {users.map((user) => (
                  <li key={user.id} className="flex flex-col gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{user.displayName}</span>
                        {user.loginName !== null ? (
                          <span className="text-muted-foreground"> · {user.loginName}</span>
                        ) : null}
                      </span>
                      {user.status === "disabled" ? (
                        <Badge variant="warning">Disabled</Badge>
                      ) : null}
                      {user.status === "removed" ? <Badge variant="outline">Removed</Badge> : null}
                    </div>
                    {user.isOwner ? (
                      <p className="text-xs text-muted-foreground">
                        Owner: holds every permission.
                      </p>
                    ) : user.status === "removed" ? (
                      <p className="text-xs text-muted-foreground">
                        Can no longer sign in. Their Personal space is yours to read under Personal
                        spaces, where you can delete what is in it.
                      </p>
                    ) : (
                      <>
                        {PERMISSIONS.map((permission) => {
                          const switchId = `${id}-${user.id}-${permission}`;
                          return (
                            <div key={permission} className="flex items-center gap-2">
                              <Switch
                                id={switchId}
                                size="sm"
                                aria-label={`${INSTALLATION_PERMISSION_LABELS[permission]}: ${user.displayName}`}
                                checked={user.installationPermissions.includes(permission)}
                                disabled={pending !== null}
                                onCheckedChange={(checked) =>
                                  void toggle(user, permission, checked)
                                }
                              />
                              <Label htmlFor={switchId}>
                                {INSTALLATION_PERMISSION_LABELS[permission]}
                              </Label>
                            </div>
                          );
                        })}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="compact"
                            variant="outline"
                            aria-label={`${user.status === "disabled" ? "Turn back on" : "Disable"} ${user.displayName}`}
                            disabled={pending !== null}
                            onClick={() =>
                              void changeStatus(
                                user,
                                user.status === "disabled" ? "active" : "disabled",
                              )
                            }
                          >
                            {user.status === "disabled" ? "Turn back on" : "Disable"}
                          </Button>
                          <Button
                            type="button"
                            size="compact"
                            variant="destructive-outline"
                            aria-label={`Remove ${user.displayName}`}
                            disabled={pending !== null}
                            onClick={() => setRemoving({ userId: user.id, typed: "" })}
                          >
                            Remove
                          </Button>
                        </div>
                        {removing?.userId === user.id ? (
                          <div className="flex flex-col gap-2 rounded-md border p-3">
                            <p className="text-xs text-muted-foreground">
                              Removing {user.displayName} can't be undone. They are signed out
                              everywhere and leave every Organization, where what they made stays.
                              Their Personal space becomes yours, read-only. Type{" "}
                              <span className="font-medium text-foreground">
                                {confirmationOf(user)}
                              </span>{" "}
                              to confirm.
                            </p>
                            <Input
                              size="sm"
                              aria-label={`Type ${confirmationOf(user)} to confirm`}
                              value={removing.typed}
                              onChange={(event) =>
                                setRemoving({ userId: user.id, typed: event.target.value })
                              }
                            />
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                size="compact"
                                variant="destructive"
                                disabled={
                                  pending !== null || removing.typed.trim() !== confirmationOf(user)
                                }
                                onClick={() => void changeStatus(user, "removed")}
                              >
                                Remove {user.displayName}
                              </Button>
                              <Button
                                type="button"
                                size="compact"
                                variant="ghost"
                                onClick={() => setRemoving(undefined)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

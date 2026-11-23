import { useAtomValue } from "@effect/atom-react";
import { pendingGrantsOf } from "@t3tools/client-runtime/grants-view";
import type { SpaceId } from "@t3tools/contracts";
import {
  BuildingIcon,
  ChevronsUpDownIcon,
  HandshakeIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerCogIcon,
  SettingsIcon,
  ShieldIcon,
  UserIcon,
  UserPlusIcon,
} from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { errorMessageOf } from "../../lib/errorMessage";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import {
  createAndSelectOrganization,
  loadSpaces,
  selectSpace,
  useCurrentSpace,
  useShellGeneration,
} from "../../state/currentSpace";
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
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

/** Grants ticket 12: loans waiting for the viewer's decision, beside a Space or the selector. */
function WaitingLoans({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <Badge
      aria-label={`${count} loan${count === 1 ? "" : "s"} waiting for you`}
      size="sm"
      variant="warning"
    >
      {count}
    </Badge>
  );
}

/** Picks the Space that new Projects and Threads on this Installation go to. */
export function SpaceSelector() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const view = useCurrentSpace((state) => state.view);
  const currentSpaceId = useCurrentSpace((state) => state.currentSpaceId);
  const loadFailed = useCurrentSpace((state) => state.loadFailed);
  const navigate = useNavigate();
  const openThreadRoute = useThreadRouteTarget() !== null;
  // An explicit pick wins: a Thread or draft stays open only in the Space it belongs to, so leave it
  // for the home view instead of letting it pull the Space back.
  const pickSpace = (spaceId: SpaceId) => {
    selectSpace(spaceId);
    if (openThreadRoute) void navigate({ to: "/" });
  };
  const [creating, setCreating] = useState(false);
  // A fresh shell snapshot follows a reconnect, as after the User's Memberships changed.
  const shellGeneration = useShellGeneration(environmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the signed-in User's Spaces from the server, again after each fresh shell snapshot
  useEffect(() => {
    if (environmentId !== null && shellGeneration >= 0) void loadSpaces(environmentId);
  }, [environmentId, shellGeneration]);
  const reload = () => {
    if (environmentId !== null) void loadSpaces(environmentId);
  };

  if (view === null) {
    if (!loadFailed) return null;
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={reload}>
            <RefreshCwIcon />
            <span className="min-w-0 flex-1 truncate">Couldn't load Spaces. Retry</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  const current = view.spaces.find((space) => space.id === currentSpaceId) ?? view.spaces[0];
  const CurrentIcon = current?.kind === "organization" ? BuildingIcon : UserIcon;
  // Only the Owner lists other Users' Personal spaces, to read them.
  const ownSpaces = view.spaces.filter(
    (space) => (space.kind === "organization" && space.archived !== true) || space.isOwn,
  );
  // Only the Owner lists archived Organizations, to restore or delete them.
  const archivedOrganizations = view.spaces.filter((space) => space.archived === true);
  const othersPersonal = view.spaces.filter((space) => space.kind === "personal" && !space.isOwn);
  const waitingLoans = pendingGrantsOf(view);
  const notice =
    current === undefined
      ? "Nothing to work in yet. The Owner can turn on your Personal space or invite you to an Organization."
      : current.kind === "personal" && current.isOwn && view.isOwner !== true
        ? "The Owner can see everything in your Personal space."
        : current.kind === "personal" && !current.isOwn
          ? `Reading ${current.name}'s Personal space. New Threads can't start here.`
          : current.archived === true
            ? `${current.name} is archived: its Members can't see it and nothing runs in it.`
            : null;

  return (
    <SidebarMenu>
      {current?.pendingAdmin === true ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/settings/user/$section" params={{ section: "account" }} />}
          >
            <ShieldIcon />
            <span className="min-w-0 flex-1 truncate">
              Set up an authenticator app to become Admin
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      <SidebarMenuItem>
        <Menu
          onOpenChange={(open) => {
            if (open) reload();
          }}
        >
          <MenuTrigger render={<SidebarMenuButton aria-label="Switch Space" />}>
            <CurrentIcon />
            <span className="min-w-0 flex-1 truncate">{current?.name ?? "No Space"}</span>
            <WaitingLoans count={waitingLoans.total} />
            <ChevronsUpDownIcon />
          </MenuTrigger>
          <MenuPopup align="start" side="top">
            <MenuGroup>
              <MenuGroupLabel>Spaces</MenuGroupLabel>
              <MenuRadioGroup
                value={current?.id}
                onValueChange={(value) => pickSpace(value as SpaceId)}
              >
                {ownSpaces.map((space) => (
                  <MenuRadioItem key={space.id} value={space.id} closeOnClick>
                    <span className="min-w-0 flex-1 truncate">{space.name}</span>
                    <WaitingLoans count={waitingLoans.bySpace.get(space.id) ?? 0} />
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            {archivedOrganizations.length > 0 ? (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Archived</MenuGroupLabel>
                  <MenuRadioGroup
                    value={current?.id}
                    onValueChange={(value) => pickSpace(value as SpaceId)}
                  >
                    {archivedOrganizations.map((space) => (
                      <MenuRadioItem key={space.id} value={space.id} closeOnClick>
                        {space.name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </>
            ) : null}
            {othersPersonal.length > 0 ? (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Personal spaces (read only)</MenuGroupLabel>
                  <MenuRadioGroup
                    value={current?.id}
                    onValueChange={(value) => pickSpace(value as SpaceId)}
                  >
                    {othersPersonal.map((space) => (
                      <MenuRadioItem key={space.id} value={space.id} closeOnClick>
                        {space.name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </>
            ) : null}
            {loadFailed ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={reload}>
                  <RefreshCwIcon />
                  Couldn't refresh Spaces. Retry
                </MenuItem>
              </>
            ) : null}
            {waitingLoans.total > 0 ? (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() =>
                    void navigate({
                      to: "/settings/user/$section",
                      params: { section: "machines" },
                      hash: "grants",
                    })
                  }
                >
                  <HandshakeIcon />
                  Loans waiting for you
                  <WaitingLoans count={waitingLoans.total} />
                </MenuItem>
              </>
            ) : null}
            {current !== undefined ? (
              <>
                <MenuSeparator />
                {current.kind === "organization" && current.canInvite ? (
                  <MenuItem
                    onClick={() =>
                      void navigate({
                        to: "/settings/space/$spaceId/$section",
                        params: { spaceId: current.id, section: "invitations" },
                      })
                    }
                  >
                    <UserPlusIcon />
                    Invite people
                  </MenuItem>
                ) : null}
                <MenuItem
                  onClick={() =>
                    void navigate({
                      to: "/settings/space/$spaceId/$section",
                      params: { spaceId: current.id, section: "general" },
                    })
                  }
                >
                  <SettingsIcon />
                  Space settings
                </MenuItem>
              </>
            ) : null}
            {view.canCreateOrganization ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => setCreating(true)}>
                  <PlusIcon />
                  Create organization
                </MenuItem>
              </>
            ) : null}
            {view.isOwner === true ? (
              <MenuItem
                onClick={() =>
                  void navigate({ to: "/settings/platform/$section", params: { section: "users" } })
                }
              >
                <ServerCogIcon />
                Platform
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
        {creating ? <CreateOrganizationDialog onClose={() => setCreating(false)} /> : null}
        {notice !== null ? (
          <p className="px-2 pt-1 text-muted-foreground text-xs">{notice}</p>
        ) : null}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function CreateOrganizationDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createAndSelectOrganization(name.trim());
      onClose();
    } catch (cause) {
      // A name another Organization has is refused with the reason; say it as the server does.
      setError(errorMessageOf(cause, "Could not create the organization. Try again."));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>
              A Space your team shares. New Projects and Threads go to the Space you pick here.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                autoFocus
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {error ? <p className="text-destructive text-sm">{error}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim().length === 0}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

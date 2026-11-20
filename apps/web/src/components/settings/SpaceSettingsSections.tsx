import {
  canRevokeInvitation,
  createInvitation,
  INVITATION_STATUS_LABELS,
  invitationLink,
  listInvitations,
  revokeInvitation,
  SPACE_ROLE_LABELS,
} from "@t3tools/client-runtime/spaces/invitations";
import {
  changeMemberRole,
  heldByKeycloak,
  issueMemberResetLink,
  LEAVE_MANAGED_HINT,
  leaveOrganization,
  listMembers,
  MANAGED_BY_KEYCLOAK_HINT as MANAGED_HINT,
  managedByKeycloakLabel as managedLabel,
  memberRoleChoices,
  removeMember,
  resetLink,
} from "@t3tools/client-runtime/spaces/memberships";
import {
  archiveOrganization,
  deleteOrganization,
  restoreOrganization,
} from "@t3tools/client-runtime/spaces/space-directory";
import type {
  InvitationSummary,
  MemberList,
  MemberSummary,
  SpaceRole,
  SpaceSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { useEffect, useId, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readHubLinkOrigin } from "../../hubLinks";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { loadSpaces, useCurrentSpace } from "../../state/currentSpace";
import { useCloseAppModal } from "../sidebar/mainAppLocation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsSpace } from "./useSettingsSpace";

type Client = Effect.Success<typeof PrimaryEnvironmentHttpClient>;
const withClient = <A, E>(use: (client: Client) => Effect.Effect<A, E>) =>
  runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(use)));

// Links point at the Hub's public URL, so they work wherever they are opened.
const linkOrigin = () => readHubLinkOrigin() ?? window.location.origin;

const formatDay = (date: DateTime.Utc) => DateTime.toDate(date).toLocaleDateString();

const confirmDestructive = async (message: string) =>
  (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);

function describeInvitation(invitation: InvitationSummary) {
  switch (invitation.status) {
    case "accepted":
      return `Accepted by ${invitation.acceptedByName ?? "a removed User"}`;
    case "revoked":
      return "Revoked";
    case "expired":
      return `Expired ${formatDay(invitation.expiresAt)}`;
    case "pending":
      return `Expires ${formatDay(invitation.expiresAt)}`;
  }
}

/** A link shown once, with a button to copy it. */
function OneTimeLink({ label, link, note }: { label: string; link: string; note: string }) {
  const id = useId();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: label.toLowerCase() });
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} readOnly value={link} className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => copyToClipboard(link)}>
          {isCopied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/** The Organization's Members, loaded when its section opens. */
function useMemberList(spaceId: SpaceSummary["id"] | null) {
  const [members, setMembers] = useState<MemberList | null>(null);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Organization's Members from the server when its section opens
  useEffect(() => {
    if (spaceId === null) return;
    let cancelled = false;
    void withClient((client) => listMembers(client, spaceId)).then(
      (list) => {
        if (!cancelled) setMembers(list);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the members."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [spaceId]);
  return { members, setMembers, error, setError };
}

/** Reloads the Spaces, as after the Organization was archived, restored, deleted or left. */
function useReloadSpaces() {
  const environmentId = useCurrentSpace((state) => state.environmentId);
  return () => {
    if (environmentId !== null) void loadSpaces(environmentId);
  };
}

/** The Space is still loading, or this URL names one the viewer cannot open. */
function SpaceUnavailable() {
  return (
    <SettingsPageContainer>
      <p className="text-sm text-muted-foreground">Loading...</p>
    </SettingsPageContainer>
  );
}

/**
 * General: what the Space is and, for an Organization, the ways out of it. Only the Owner
 * archives, restores and deletes; a Member leaves. What each viewer may change comes from the
 * server's answers; the server refuses the rest anyway.
 */
export function SpaceGeneralSection() {
  const space = useSettingsSpace();
  if (space === null) return <SpaceUnavailable />;
  return <SpaceGeneral space={space} />;
}

function SpaceGeneral({ space }: { readonly space: SpaceSummary }) {
  const isOwner = useCurrentSpace((state) => state.view?.isOwner === true);
  const closeAppModal = useCloseAppModal();
  const reload = useReloadSpaces();
  const isOrganization = space.kind === "organization";
  const { members, error: loadError } = useMemberList(isOrganization ? space.id : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A Keycloak group gives the viewer this Membership (ticket 05): left only by leaving the group.
  const managedYou = members?.members.find((member) => member.isYou && member.managedByKeycloak);

  const leave = async () => {
    const confirmed = await confirmDestructive(
      `Leave ${space.name}?\nWhat you created stays in the Organization. To come back you need a new invitation.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await withClient((client) => leaveOrganization(client, space.id));
      // The Organization is gone from the viewer's Spaces: leave the modal, then reload them.
      await closeAppModal();
      reload();
    } catch (cause) {
      setError(messageOf(cause, "Could not leave the Organization."));
    }
    setBusy(false);
  };

  const notice = isOrganization
    ? null
    : space.isOwn
      ? "The Owner can see everything in your Personal space."
      : `Reading ${space.name}'s Personal space. New Threads can't start here.`;

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-1" aria-labelledby="space-general">
          <h3 id="space-general" className="text-sm font-medium">
            {space.name}
          </h3>
          <p className="text-xs text-muted-foreground">
            {isOrganization
              ? `Organization${space.role === null ? "" : ` · You are ${SPACE_ROLE_LABELS[space.role]}`}`
              : "Personal space"}
          </p>
          {notice !== null ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
        </section>

        {isOrganization && isOwner ? (
          <LifecycleSection
            space={space}
            onChanged={reload}
            onDeleted={() => {
              reload();
              void closeAppModal();
            }}
          />
        ) : null}

        {members !== null && !members.canLeave && managedYou !== undefined ? (
          <section className="flex flex-col gap-2" aria-labelledby="space-leave">
            <h3 id="space-leave" className="text-sm font-medium">
              Leave
            </h3>
            <p className="text-xs text-muted-foreground" id="space-leave-managed">
              {managedLabel(managedYou)}. {LEAVE_MANAGED_HINT}
            </p>
            <div>
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                disabled
                aria-describedby="space-leave-managed"
              >
                Leave organization
              </Button>
            </div>
          </section>
        ) : null}

        {members?.canLeave ? (
          <section className="flex flex-col gap-2" aria-labelledby="space-leave">
            <h3 id="space-leave" className="text-sm font-medium">
              Leave
            </h3>
            <p className="text-xs text-muted-foreground">
              What you created stays in the Organization. To come back you need a new invitation.
            </p>
            <div>
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                disabled={busy}
                onClick={() => void leave()}
              >
                Leave organization
              </Button>
            </div>
          </section>
        ) : null}

        {(error ?? loadError) ? (
          <p className="text-destructive text-sm">{error ?? loadError}</p>
        ) : null}
      </div>
    </SettingsPageContainer>
  );
}

/** Members, their Roles and what the viewer may do to each. */
export function SpaceMembersSection() {
  const space = useSettingsSpace();
  if (space === null || space.kind !== "organization") return <SpaceUnavailable />;
  return <SpaceMembers space={space} />;
}

function SpaceMembers({ space }: { readonly space: SpaceSummary }) {
  const { members, setMembers, error: loadError } = useMemberList(space.id);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ readonly name: string; readonly url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause, failure));
    }
    setBusy(false);
  };

  const reload = async () =>
    setMembers(await withClient((client) => listMembers(client, space.id)));

  const changeRole = (member: MemberSummary, role: SpaceRole) =>
    run(async () => {
      const result = await withClient((client) =>
        changeMemberRole(client, space.id, member.userId, role),
      );
      await reload();
      if (result.pendingAdmin) {
        setNotice(
          `${member.displayName} becomes an Admin once they add an authenticator app in User settings → Account. Until then they act as a Member.`,
        );
      } else if (result.signedOut) {
        setNotice(
          `${member.displayName} was signed out. As an Admin they sign in with their passkey, or with their password and an authenticator app.`,
        );
      }
    }, "Could not change the Role.");

  const remove = async (member: MemberSummary) => {
    const confirmed = await confirmDestructive(
      `Remove ${member.displayName} from ${space.name}?\nWhat they created stays in the Organization. They can come back with a new invitation.`,
    );
    if (!confirmed) return;
    await run(async () => {
      setMembers(await withClient((client) => removeMember(client, space.id, member.userId)));
    }, "Could not remove them.");
  };

  const issueResetLink = (member: MemberSummary) =>
    run(async () => {
      const issued = await withClient((client) =>
        issueMemberResetLink(client, space.id, member.userId),
      );
      setLink({ name: member.displayName, url: resetLink(linkOrigin(), issued.token) });
    }, "Could not create the reset link.");

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2" aria-labelledby="organization-members">
          <h3 id="organization-members" className="text-sm font-medium">
            Members
          </h3>
          {members === null ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : members.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody has joined yet.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Members">
              {members.members.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  assignableRoles={members.assignableRoles}
                  busy={busy}
                  onChangeRole={(role) => void changeRole(member, role)}
                  onRemove={() => void remove(member)}
                  onResetLink={() => void issueResetLink(member)}
                />
              ))}
            </ul>
          )}
          {link !== null ? (
            <OneTimeLink
              label={`Reset link for ${link.name}`}
              link={link.url}
              note="Works once and expires in an hour. It lets them set a new password or passkey, ends their old ones and signs out their devices. Shown only now."
            />
          ) : null}
          {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
        </section>
        {(error ?? loadError) ? (
          <p className="text-destructive text-sm">{error ?? loadError}</p>
        ) : null}
      </div>
    </SettingsPageContainer>
  );
}

/** Create a link, copy it, see and revoke the Invitations. Only who may invite sees it. */
export function SpaceInvitationsSection() {
  const space = useSettingsSpace();
  const { members } = useMemberList(space?.kind === "organization" ? space.id : null);
  if (space === null || space.kind !== "organization" || !space.canInvite) {
    return <SpaceUnavailable />;
  }
  return (
    <SettingsPageContainer>
      <InvitationsSection
        space={space}
        assignableRoles={members?.assignableRoles ?? ["member", "guest"]}
      />
    </SettingsPageContainer>
  );
}

const roleItems = (roles: ReadonlyArray<SpaceRole>) =>
  roles.map((role) => ({ value: role, label: SPACE_ROLE_LABELS[role] }));

function MemberRow({
  member,
  assignableRoles,
  busy,
  onChangeRole,
  onRemove,
  onResetLink,
}: {
  readonly member: MemberSummary;
  readonly assignableRoles: ReadonlyArray<SpaceRole>;
  readonly busy: boolean;
  readonly onChangeRole: (role: SpaceRole) => void;
  readonly onRemove: () => void;
  readonly onResetLink: () => void;
}) {
  const memberRoleItems = roleItems(memberRoleChoices(member, assignableRoles));
  // Who manages others (an Admin, the Owner) sees a managed Membership's controls, held back.
  const held = heldByKeycloak(member, assignableRoles);
  const hintId = `managed-${member.userId}`;
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">
          {member.displayName}
          {member.isYou ? <span className="text-muted-foreground"> (you)</span> : null}
          {member.pendingAdmin && member.canChangeRole ? (
            <span className="text-muted-foreground">
              {" "}
              · Admin once they add an authenticator app
            </span>
          ) : null}
        </span>
        {member.managedByKeycloak ? (
          <Badge size="sm" variant="secondary" title={MANAGED_HINT}>
            {managedLabel(member)}
          </Badge>
        ) : null}
        {held ? (
          <span id={hintId} className="sr-only">
            {MANAGED_HINT}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {member.canChangeRole ? (
          <div className="w-36">
            <Select
              disabled={busy}
              items={memberRoleItems}
              value={member.role}
              onValueChange={(value) => {
                if (value !== null) onChangeRole(value as SpaceRole);
              }}
            >
              <SelectTrigger aria-label={`Role for ${member.displayName}`} size="xs">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {memberRoleItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : held ? (
          <div className="w-36">
            <Select disabled items={memberRoleItems} value={member.role}>
              <SelectTrigger
                aria-label={`Role for ${member.displayName}`}
                aria-describedby={hintId}
                size="xs"
                title={MANAGED_HINT}
              >
                <SelectValue />
              </SelectTrigger>
            </Select>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {SPACE_ROLE_LABELS[member.role]}
            {member.pendingAdmin ? " (pending)" : ""}
          </span>
        )}
        {member.canIssueResetLink ? (
          <Button
            aria-label={`Create a reset link for ${member.displayName}`}
            disabled={busy}
            size="xs"
            variant="ghost"
            onClick={onResetLink}
          >
            Reset link
          </Button>
        ) : null}
        {member.canRemove ? (
          <Button
            aria-label={`Remove ${member.displayName}`}
            disabled={busy}
            size="xs"
            variant="ghost"
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : held ? (
          <Button
            aria-label={`Remove ${member.displayName}`}
            aria-describedby={hintId}
            disabled
            size="xs"
            title={MANAGED_HINT}
            variant="ghost"
          >
            Remove
          </Button>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Archive (hidden from Members, nothing runs) and restore; permanent deletion only once archived,
 * after typing the name.
 */
function LifecycleSection({
  space,
  onChanged,
  onDeleted,
}: {
  readonly space: SpaceSummary;
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [typedName, setTypedName] = useState("");
  const archived = space.archived === true;

  const run = async (action: () => Promise<unknown>, failure: string, after: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after();
    } catch (cause) {
      setError(messageOf(cause, failure));
    }
    setBusy(false);
  };

  const archive = async () => {
    const confirmed = await confirmDestructive(
      `Archive ${space.name}?
Its Members stop seeing it, running Threads stop and scheduled tasks in it don't run. You can restore it later.`,
    );
    if (!confirmed) return;
    await run(
      () => withClient((client) => archiveOrganization(client, space.id)),
      "Could not archive the organization.",
      onChanged,
    );
  };

  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-sm font-medium">
        {archived ? "Archived" : "Archive"}
      </h3>
      <p className="text-xs text-muted-foreground">
        {archived
          ? "Its Members can't see it and nothing runs in it. Restore it to bring it back, or delete it with all its Projects and Threads."
          : "Hides it from its Members and stops everything that runs in it, until you restore it."}
      </p>
      <div className="flex flex-wrap gap-2">
        {archived ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () => withClient((client) => restoreOrganization(client, space.id)),
                  "Could not restore the organization.",
                  onChanged,
                )
              }
            >
              Restore organization
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete organization
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void archive()}>
            Archive organization
          </Button>
        )}
      </div>
      {archived && confirmingDelete ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => withClient((client) => deleteOrganization(client, space.id)),
              "Could not delete the organization.",
              onDeleted,
            );
          }}
        >
          <Label htmlFor={`${id}-confirm`}>Type {space.name} to delete it permanently</Label>
          <p className="text-xs text-muted-foreground">
            Deletes its Projects, Threads, Members and Invitations. This can't be undone.
          </p>
          <div className="flex gap-2">
            <Input
              id={`${id}-confirm`}
              autoComplete="off"
              className="flex-1"
              value={typedName}
              onChange={(event) => setTypedName(event.currentTarget.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={busy || typedName.trim() !== space.name}
            >
              Delete permanently
            </Button>
          </div>
        </form>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </section>
  );
}

const fetchInvitations = (spaceId: SpaceSummary["id"]) =>
  withClient((client) => listInvitations(client, spaceId));

/** Create a link, copy it, see and revoke the Organization's Invitations. */
function InvitationsSection({
  space,
  assignableRoles,
}: {
  readonly space: SpaceSummary;
  readonly assignableRoles: ReadonlyArray<SpaceRole>;
}) {
  const id = useId();
  const [role, setRole] = useState<SpaceRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<ReadonlyArray<InvitationSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setInvitations((await fetchInvitations(space.id)).invitations);
    } catch (cause) {
      setError(messageOf(cause, "Could not load the invitations."));
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Organization's Invitations from the server when its section opens
  useEffect(() => {
    let cancelled = false;
    void fetchInvitations(space.id).then(
      (list) => {
        if (!cancelled) setInvitations(list.invitations);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the invitations."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [space.id]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await withClient((client) => createInvitation(client, space.id, role));
      setLink(invitationLink(linkOrigin(), created.token));
      await reload();
    } catch (cause) {
      setError(messageOf(cause, "Could not create the invitation."));
    }
    setBusy(false);
  };

  const revoke = async (invitation: InvitationSummary) => {
    setBusy(true);
    setError(null);
    try {
      await withClient((client) => revokeInvitation(client, invitation.id));
      await reload();
    } catch (cause) {
      setError(messageOf(cause, "Could not revoke the invitation."));
    }
    setBusy(false);
  };

  const inviteRoleItems = roleItems(assignableRoles);
  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-heading`} className="text-sm font-medium">
          Invitations
        </h3>
        <p className="text-xs text-muted-foreground">
          Each link works once and expires in 7 days. Send it over any chat app.
        </p>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor={`${id}-role`}>Role</Label>
          <Select
            disabled={busy}
            items={inviteRoleItems}
            value={role}
            onValueChange={(value) => {
              if (value !== null) setRole(value as SpaceRole);
            }}
          >
            <SelectTrigger id={`${id}-role`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {inviteRoleItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Button disabled={busy} size="sm" onClick={() => void create()}>
          Create invite link
        </Button>
      </div>

      {link !== null ? (
        <OneTimeLink
          label="Invitation link"
          link={link}
          note="Shown only now: the server keeps no copy of the link."
        />
      ) : null}

      {invitations === null ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : invitations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invitations yet.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Invitations">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {SPACE_ROLE_LABELS[invitation.role]} · {INVITATION_STATUS_LABELS[invitation.status]}{" "}
                · <span className="text-muted-foreground">{describeInvitation(invitation)}</span>
              </span>
              {canRevokeInvitation(invitation, assignableRoles) ? (
                <Button
                  disabled={busy}
                  size="xs"
                  variant="ghost"
                  onClick={() => void revoke(invitation)}
                >
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </section>
  );
}

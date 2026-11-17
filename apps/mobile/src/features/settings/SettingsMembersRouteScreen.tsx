import { SPACE_ROLE_LABELS } from "@t3tools/client-runtime/spaces/invitations";
import {
  changeMemberRole,
  leaveOrganization,
  listMembers,
  memberRoleChoices,
  removeMember,
} from "@t3tools/client-runtime/spaces/memberships";
import type { MemberSummary, SpaceRole } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { callHub, reasonOf, useSpaceMembers } from "../../state/space-admin";
import { reloadSpaces } from "../../state/spaces";
import { workspaceHasColumns } from "../workspace/workspace-selection-store";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { leaveSettingsPage } from "./settings-navigation";
import { useSettingsOrganization } from "./useSettingsOrganization";

/**
 * The Organization's Members and their Roles. What the viewer may do to each Member comes from the
 * Hub's answer in the list, as on web; nothing here decides it.
 */
export function SettingsMembersRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const organization = useSettingsOrganization();
  const {
    members,
    setMembers,
    error: loadError,
  } = useSpaceMembers(organization?.hub ?? null, organization?.space.id ?? null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(reasonOf(cause, failure));
    }
    setBusy(false);
  };

  const selected = members?.members.find((member) => member.userId === selectedUserId) ?? null;

  const content = (() => {
    if (organization === null) {
      return (
        <EmptyState
          variant="plain"
          title="No Organization"
          detail="Pick an Organization in the Space selector to see its Members."
        />
      );
    }
    const { hub, space } = organization;

    const changeRole = (member: MemberSummary, role: SpaceRole) =>
      run(async () => {
        const result = await callHub(hub, (client, headers) =>
          changeMemberRole(client, space.id, member.userId, role, headers),
        );
        setMembers(await callHub(hub, (client, headers) => listMembers(client, space.id, headers)));
        if (result.pendingAdmin) {
          setNotice(
            `${member.displayName} becomes an Admin once they add an authenticator app in User settings. Until then they act as a Member.`,
          );
        } else if (result.signedOut) {
          setNotice(
            `${member.displayName} was signed out. As an Admin they sign in with their passkey, or with their password and an authenticator app.`,
          );
        }
      }, "Could not change the Role.");

    const confirmRemove = (member: MemberSummary) =>
      Dialog.confirm({
        title: `Remove ${member.displayName}?`,
        message: `What they created stays in ${space.name}. They can come back with a new invitation.`,
        confirmText: "Remove",
        destructive: true,
        onConfirm: () =>
          void run(async () => {
            setMembers(
              await callHub(hub, (client, headers) =>
                removeMember(client, space.id, member.userId, headers),
              ),
            );
            setSelectedUserId(null);
          }, "Could not remove them."),
      });

    const confirmLeave = () =>
      Dialog.confirm({
        title: `Leave ${space.name}?`,
        message:
          "What you created stays in the Organization. To come back you need a new invitation.",
        confirmText: "Leave",
        destructive: true,
        onConfirm: () =>
          void run(async () => {
            await callHub(hub, (client, headers) => leaveOrganization(client, space.id, headers));
            // The Organization is gone from the viewer's Spaces: reload them and go back.
            await reloadSpaces(hub);
            leaveSettingsPage(navigation, workspaceHasColumns(), "SettingsSpace");
          }, "Could not leave the Organization."),
      });

    if (members === null) {
      return loadError === null ? null : <ErrorBanner message={loadError} />;
    }

    return (
      <>
        <SettingsSection title={space.name}>
          {members.members.map((member) => {
            const label = member.isYou ? `${member.displayName} (you)` : member.displayName;
            const roleLabel = `${SPACE_ROLE_LABELS[member.role]}${member.pendingAdmin ? " (pending)" : ""}`;
            return member.canChangeRole || member.canRemove ? (
              <ListRow
                key={member.userId}
                label={label}
                detail={roleLabel}
                disabled={busy}
                onPress={() =>
                  setSelectedUserId(member.userId === selectedUserId ? null : member.userId)
                }
              />
            ) : (
              <ListRowLayout key={member.userId} label={label} detail={roleLabel} />
            );
          })}
        </SettingsSection>

        {selected !== null && selected.canChangeRole ? (
          <SettingsSection title={`Role of ${selected.displayName}`}>
            {memberRoleChoices(selected, members.assignableRoles).map((role, index) => (
              <ListChoiceRow
                key={role}
                label={SPACE_ROLE_LABELS[role]}
                selected={role === selected.role}
                separated={index > 0}
                disabled={busy}
                onPress={() => {
                  if (role !== selected.role) void changeRole(selected, role);
                }}
              />
            ))}
          </SettingsSection>
        ) : null}

        {selected !== null && selected.canRemove ? (
          <SettingsSection>
            <ListActionRow
              label={`Remove ${selected.displayName}`}
              tone="danger"
              disabled={busy}
              onPress={() => confirmRemove(selected)}
            />
          </SettingsSection>
        ) : null}

        {members.canLeave ? (
          <SettingsSection footer="What you created stays in the Organization. To come back you need a new invitation.">
            <ListActionRow
              label="Leave organization"
              tone="danger"
              disabled={busy}
              onPress={confirmLeave}
            />
          </SettingsSection>
        ) : null}

        {notice !== null ? <Notice message={notice} /> : null}
        {error !== null ? <ErrorBanner message={error} /> : null}
      </>
    );
  })();

  return (
    <SettingsScreen title="Members">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {content}
      </ScrollView>
    </SettingsScreen>
  );
}

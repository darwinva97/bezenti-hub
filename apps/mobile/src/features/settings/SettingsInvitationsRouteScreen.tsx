import {
  canRevokeInvitation,
  createInvitation,
  INVITATION_STATUS_LABELS,
  invitationLink,
  listInvitations,
  revokeInvitation,
  SPACE_ROLE_LABELS,
} from "@t3tools/client-runtime/spaces/invitations";
import type { InvitationSummary, SpaceRole } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";
import { Share } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { callHub, reasonOf, useSpaceMembers } from "../../state/space-admin";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsOrganization } from "./useSettingsOrganization";

const DEFAULT_ASSIGNABLE: ReadonlyArray<SpaceRole> = ["member", "guest"];

function describeInvitation(invitation: InvitationSummary): string {
  const day = DateTime.toDate(invitation.expiresAt).toLocaleDateString();
  switch (invitation.status) {
    case "accepted":
      return `Accepted by ${invitation.acceptedByName ?? "a removed User"}`;
    case "revoked":
      return "Revoked";
    case "expired":
      return `Expired ${day}`;
    case "pending":
      return `Expires ${day}`;
  }
}

/** Create a link, share or copy it, see and revoke the Organization's Invitations. */
export function SettingsInvitationsRouteScreen() {
  const insets = useSafeAreaInsets();
  const organization = useSettingsOrganization();
  const hub = organization?.hub ?? null;
  const space = organization?.space ?? null;
  const { members } = useSpaceMembers(hub, space?.id ?? null);
  const assignableRoles = members?.assignableRoles ?? DEFAULT_ASSIGNABLE;
  const [role, setRole] = useState<SpaceRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [invitations, setInvitations] = useState<ReadonlyArray<InvitationSummary> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Organization's Invitations from the Hub when the screen opens
  useEffect(() => {
    if (hub === null || space === null) return;
    let cancelled = false;
    void callHub(hub, (client, headers) => listInvitations(client, space.id, headers)).then(
      (list) => {
        if (!cancelled) setInvitations(list.invitations);
      },
      (cause: unknown) => {
        if (!cancelled) setError(reasonOf(cause, "Could not load the invitations."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hub, space]);

  const content = (() => {
    if (hub === null || space === null || !space.canInvite) {
      return (
        <EmptyState
          variant="plain"
          title="No invitations here"
          detail="Only who runs an Organization can invite people to it."
        />
      );
    }

    const reload = async () => {
      const list = await callHub(hub, (client, headers) =>
        listInvitations(client, space.id, headers),
      );
      setInvitations(list.invitations);
    };

    const run = async (action: () => Promise<void>, failure: string) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(reasonOf(cause, failure));
      }
      setBusy(false);
    };

    const create = () =>
      run(async () => {
        const created = await callHub(hub, (client, headers) =>
          createInvitation(client, space.id, role, headers),
        );
        setLink(invitationLink(new URL(hub.httpBaseUrl).origin, created.token));
        setCopied(false);
        await reload();
      }, "Could not create the invitation.");

    const confirmRevoke = (invitation: InvitationSummary) =>
      Dialog.confirm({
        title: "Revoke this invitation?",
        message: "Its link stops working.",
        confirmText: "Revoke",
        destructive: true,
        onConfirm: () =>
          void run(async () => {
            await callHub(hub, (client, headers) =>
              revokeInvitation(client, invitation.id, headers),
            );
            await reload();
          }, "Could not revoke the invitation."),
      });

    return (
      <>
        <SettingsSection
          title="Role"
          footer="Each link works once and expires in 7 days. Send it over any chat app."
        >
          {assignableRoles.map((choice, index) => (
            <ListChoiceRow
              key={choice}
              label={SPACE_ROLE_LABELS[choice]}
              selected={choice === role}
              separated={index > 0}
              disabled={busy}
              onPress={() => setRole(choice)}
            />
          ))}
        </SettingsSection>

        <SettingsSection>
          <ListActionRow
            icon="link"
            label="Create invite link"
            loading={busy}
            onPress={() => void create()}
          />
        </SettingsSection>

        {link !== null ? (
          <SettingsSection
            title="Invitation link"
            footer="Shown only now: the Hub keeps no copy of the link."
          >
            <ListRowLayout label={link} />
            <ListActionRow
              icon="square.and.arrow.up"
              label="Share link"
              onPress={() => void Share.share({ message: link })}
            />
            <ListActionRow
              icon="doc.on.doc"
              label={copied ? "Copied" : "Copy link"}
              onPress={() =>
                void tryCopyTextWithHaptic(link, { target: "invitation link" }).then(setCopied)
              }
            />
          </SettingsSection>
        ) : null}

        {invitations === null ? null : invitations.length === 0 ? (
          <SettingsSection title="Invitations">
            <ListRowLayout label="No invitations yet." />
          </SettingsSection>
        ) : (
          <SettingsSection title="Invitations">
            {invitations.map((invitation) => {
              const content = {
                label: `${SPACE_ROLE_LABELS[invitation.role]} · ${INVITATION_STATUS_LABELS[invitation.status]}`,
                description: describeInvitation(invitation),
              };
              return canRevokeInvitation(invitation, assignableRoles) ? (
                <ListRow
                  key={invitation.id}
                  {...content}
                  description={`${content.description} · Tap to revoke`}
                  disabled={busy}
                  onPress={() => confirmRevoke(invitation)}
                />
              ) : (
                <ListRowLayout key={invitation.id} {...content} />
              );
            })}
          </SettingsSection>
        )}

        {error !== null ? <ErrorBanner message={error} /> : null}
      </>
    );
  })();

  return (
    <SettingsScreen title="Invitations">
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

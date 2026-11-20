import {
  createPlatformInvitation,
  invitationLink,
  listPlatformInvitations,
  revokeInvitation,
} from "@t3tools/client-runtime/spaces/invitations";
import type { PlatformInvitationSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { useEffect, useId, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { readHubLinkOrigin } from "../../hubLinks";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";
import { OneTimeLink } from "./SpaceSettingsSections";

type Client = Effect.Success<typeof PrimaryEnvironmentHttpClient>;
const withClient = <A, E>(use: (client: Client) => Effect.Effect<A, E>) =>
  runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(use)));

// Links point at the Hub's public URL, so they work wherever they are opened.
const linkOrigin = () => readHubLinkOrigin() ?? window.location.origin;

const fetchPending = () => withClient((client) => listPlatformInvitations(client));

const describe = (invitation: PlatformInvitationSummary) =>
  `Created by ${invitation.createdByName ?? "a removed User"} · Expires ${DateTime.toDate(
    invitation.expiresAt,
  ).toLocaleDateString()}`;

/**
 * The Owner's Platform invitations (Keycloak sign-in, ticket 04): a link that gives one person a
 * User on this Hub, whatever the Registration mode, without any Organization. Shown once to copy;
 * the pending ones listed, each revocable.
 */
export function PlatformInvitations() {
  const id = useId();
  const [link, setLink] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlyArray<PlatformInvitationSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setPending((await fetchPending()).invitations);
    } catch (cause) {
      setError(messageOf(cause, "Could not load the Platform invitations."));
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the pending Platform invitations from the server when the section opens
  useEffect(() => {
    let cancelled = false;
    void fetchPending().then(
      (list) => {
        if (!cancelled) setPending(list.invitations);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the Platform invitations."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await withClient((client) => createPlatformInvitation(client));
      setLink(invitationLink(linkOrigin(), created.token));
      await reload();
    } catch (cause) {
      setError(messageOf(cause, "Could not create the Platform invitation."));
    }
    setBusy(false);
  };

  const revoke = async (invitation: PlatformInvitationSummary) => {
    const message = "Revoke this Platform invitation?\nIts link stops working at once.";
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await withClient((client) => revokeInvitation(client, invitation.id));
      await reload();
    } catch (cause) {
      setError(messageOf(cause, "Could not revoke the Platform invitation."));
    }
    setBusy(false);
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-heading`} className="text-sm font-medium">
          Platform invitations
        </h3>
        <p className="text-xs text-muted-foreground">
          A link that gives one person an account on this Hub, whatever the mode above, without
          adding them to any Organization. It works once and expires in 7 days.
        </p>
      </div>
      <div>
        <Button disabled={busy} size="sm" onClick={() => void create()}>
          Create Platform invitation
        </Button>
      </div>

      {link !== null ? (
        <OneTimeLink
          label="Platform invitation link"
          link={link}
          note="Shown only now: the server keeps no copy of the link."
        />
      ) : null}

      {pending === null ? (
        error === null ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : null
      ) : pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pending Platform invitations.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Pending Platform invitations">
          {pending.map((invitation) => (
            <li key={invitation.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-muted-foreground">{describe(invitation)}</span>
              <Button
                disabled={busy}
                size="xs"
                variant="ghost"
                onClick={() => void revoke(invitation)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </section>
  );
}

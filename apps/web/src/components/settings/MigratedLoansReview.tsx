import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GrantMigrationReview,
  GrantVaultGroupMigrationReview,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { giveGrant } from "../../environments/primary/grants";
import { errorMessageOf } from "../../lib/errorMessage";
import { grantsEnvironment } from "../../state/grants";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { peekKeycloakStepUp } from "../auth/keycloakStepUp";
import { LendVaultGroupDialog } from "./LendVaultGroupDialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Grants ticket 02, the Owner only: the AI accounts an allowance «to a User» reached in an
 * Organization before the upgrade made it a loan to that User's Personal space. Shown until the
 * Owner lends each to the Organization (to all who work there) or dismisses it; nothing here
 * reaches anyone until then.
 */
export function MigratedLoansReview({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const list = useAtomCommand(grantsEnvironment.migrationReviews, "list the loans to review");
  const dismiss = useAtomCommand(grantsEnvironment.dismissMigrationReview, "dismiss a review");
  const [reviews, setReviews] = useState<ReadonlyArray<GrantMigrationReview> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useEffectEvent((target: EnvironmentId) =>
    list({ environmentId: target, input: {} }),
  );
  const apply = useEffectEvent((found: Awaited<ReturnType<typeof list>>) => {
    if (found._tag === "Success") setReviews(found.value.reviews);
    else setError(errorMessageOf(squashAtomCommandFailure(found), "Could not read the review."));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Owner's review of migrated loans when the page opens.
  useEffect(() => {
    let cancelled = false;
    void load(environmentId).then((found) => {
      if (!cancelled) apply(found);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const run = async (change: () => Promise<ReadonlyArray<GrantMigrationReview>>) => {
    setPending(true);
    setError(null);
    try {
      setReviews(await change());
    } catch (cause) {
      setError(errorMessageOf(cause, "That change did not go through."));
    } finally {
      setPending(false);
    }
  };
  const reread = async () => {
    const found = await list({ environmentId, input: {} });
    if (found._tag !== "Success") throw squashAtomCommandFailure(found);
    return found.value.reviews;
  };

  if (reviews === null && error === null) return null;
  if ((reviews ?? []).length === 0 && error === null) return null;
  return (
    <SettingsSection id="ai-accounts-migrated-loans" title="Review migrated loans">
      <SettingsRow
        title="What the upgrade narrowed"
        description="Allowances became loans. One allowed «to a User» now reaches only their Personal space; before, they could use it in every Organization below. Lend it to an Organization to give it to everyone who works there, or dismiss it."
        status={
          error === null ? null : (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          )
        }
      />
      {(reviews ?? []).map((review) => (
        <SettingsRow
          key={`${review.aiAccountId}|${review.userId}|${review.spaceId}`}
          title={`${review.aiAccountName} · ${review.userName} in ${review.spaceName}`}
          description={
            review.usedRecently
              ? `${review.userName} used it there in the last 90 days.`
              : `${review.userName} did not use it there in the last 90 days.`
          }
          control={
            <div className="flex gap-1">
              <Button
                disabled={pending}
                size="xs"
                aria-label={`Lend ${review.aiAccountName} to ${review.spaceName}`}
                onClick={() =>
                  void run(async () => {
                    await giveGrant(
                      {
                        resource: { kind: "ai-account", aiAccountId: review.aiAccountId },
                        spaceId: review.spaceId,
                        limits: { kind: "ai-account", tokens: null, requests: null },
                      },
                      undefined,
                    );
                    return reread();
                  })
                }
              >
                {review.startsActive
                  ? `Lend to ${review.spaceName}`
                  : `Offer to ${review.spaceName}`}
              </Button>
              <Button
                disabled={pending}
                size="xs"
                variant="outline"
                aria-label={`Dismiss ${review.aiAccountName} for ${review.userName} in ${review.spaceName}`}
                onClick={() =>
                  void run(async () => {
                    const done = await dismiss({
                      environmentId,
                      input: {
                        aiAccountId: review.aiAccountId,
                        userId: review.userId,
                        spaceId: review.spaceId,
                      },
                    });
                    if (done._tag !== "Success") throw squashAtomCommandFailure(done);
                    return done.value.reviews;
                  })
                }
              >
                Dismiss
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}

/**
 * Grants ticket 07, the Owner only: the same for Vault groups. An allowance «to a User» reached
 * their own turns in each Organization below; its loan now reaches their Personal space alone.
 * Lending one to an Organization (with a strong factor) reaches every Thread there that chooses it.
 */
export function MigratedVaultLoansReview({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const list = useAtomCommand(grantsEnvironment.migrationReviews, "list the loans to review");
  const dismiss = useAtomCommand(grantsEnvironment.dismissMigrationReview, "dismiss a review");
  const [reviews, setReviews] = useState<ReadonlyArray<GrantVaultGroupMigrationReview> | null>(
    null,
  );
  // Back from «Confirm with Keycloak», the Lend dialog it left opens again to finish.
  const [lending, setLending] = useState<Pick<
    GrantVaultGroupMigrationReview,
    "vaultGroupId" | "vaultGroupName" | "spaceId"
  > | null>(() => {
    const back = peekKeycloakStepUp("lend-vault-group");
    return back?.fromReview === true
      ? { vaultGroupId: back.group.id, vaultGroupName: back.group.name, spaceId: back.spaceId }
      : null;
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useEffectEvent((target: EnvironmentId) =>
    list({ environmentId: target, input: {} }),
  );
  const apply = useEffectEvent((found: Awaited<ReturnType<typeof list>>) => {
    if (found._tag === "Success") setReviews(found.value.vaultGroups ?? []);
    else setError(errorMessageOf(squashAtomCommandFailure(found), "Could not read the review."));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Owner's review of migrated loans when the page opens.
  useEffect(() => {
    let cancelled = false;
    void load(environmentId).then((found) => {
      if (!cancelled) apply(found);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const reread = async () => {
    const found = await list({ environmentId, input: {} });
    if (found._tag !== "Success") throw squashAtomCommandFailure(found);
    setReviews(found.value.vaultGroups ?? []);
  };

  if ((reviews ?? []).length === 0 && error === null) return null;
  return (
    <SettingsSection id="vaults-migrated-loans" title="Review migrated loans">
      <SettingsRow
        title="What the upgrade narrowed"
        description="Allowances became loans. A group allowed «to a User» now reaches only their Personal space; before, their own turns received it in every Organization below. Lend it to an Organization to give it to every Thread there that chooses it, or dismiss it."
        status={
          error === null ? null : (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          )
        }
      />
      {(reviews ?? []).map((review) => (
        <SettingsRow
          key={`${review.vaultGroupId}|${review.userId}|${review.spaceId}`}
          title={`${review.vaultGroupName} · ${review.userName} in ${review.spaceName}`}
          control={
            <div className="flex gap-1">
              <Button
                disabled={pending}
                size="xs"
                aria-label={`Lend ${review.vaultGroupName} to ${review.spaceName}`}
                onClick={() => setLending(review)}
              >
                {review.startsActive
                  ? `Lend to ${review.spaceName}…`
                  : `Offer to ${review.spaceName}…`}
              </Button>
              <Button
                disabled={pending}
                size="xs"
                variant="outline"
                aria-label={`Dismiss ${review.vaultGroupName} for ${review.userName} in ${review.spaceName}`}
                onClick={() => {
                  setPending(true);
                  setError(null);
                  void dismiss({
                    environmentId,
                    input: {
                      vaultGroupId: review.vaultGroupId,
                      userId: review.userId,
                      spaceId: review.spaceId,
                    },
                  })
                    .then((done) => {
                      if (done._tag !== "Success") throw squashAtomCommandFailure(done);
                      setReviews(done.value.vaultGroups ?? []);
                    })
                    .catch((cause: unknown) =>
                      setError(errorMessageOf(cause, "That change did not go through.")),
                    )
                    .finally(() => setPending(false));
                }}
              >
                Dismiss
              </Button>
            </div>
          }
        />
      ))}
      {lending === null ? null : (
        <LendVaultGroupDialog
          group={{ id: lending.vaultGroupId, name: lending.vaultGroupName }}
          initialSpaceId={lending.spaceId}
          onClose={() => {
            setLending(null);
            void reread().catch(() => undefined);
          }}
        />
      )}
    </SettingsSection>
  );
}

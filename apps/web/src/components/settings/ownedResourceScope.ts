import type { HubEnvironmentSummary, ResourceOwner, SpaceId } from "@t3tools/contracts";

/**
 * Whose resources a section lists: the signed-in User's own (User settings), or one Organization's
 * (its Space settings). The sections take it so the same component serves both modals.
 */
export type OwnedResourceScope =
  | { readonly kind: "user" }
  | { readonly kind: "organization"; readonly spaceId: SpaceId };

/** Whether a resource owner is the one the scope lists; `viewerUserId` is who is signed in. */
export function ownerInScope(
  scope: OwnedResourceScope,
  owner: ResourceOwner,
  viewerUserId: string | null | undefined,
): boolean {
  return scope.kind === "user"
    ? owner.kind === "user" && viewerUserId != null && owner.userId === viewerUserId
    : owner.kind === "organization" && owner.spaceId === scope.spaceId;
}

/**
 * Whether a machine is one the scope lists: the User's personal machines, or the machines
 * dedicated to the Organization (lent ones included, shown as the Hub says). The Hub machine and
 * Sandboxes are neither: the Space's Sandbox has its own row.
 */
export function machineInScope(
  scope: OwnedResourceScope,
  environment: Pick<HubEnvironmentSummary, "kind" | "mode" | "ownerUserId" | "spaceId" | "lent">,
  viewerUserId: string | null | undefined,
): boolean {
  if (environment.kind !== "external") return false;
  if (scope.kind === "user") {
    return (
      environment.mode === "personal" &&
      environment.lent === undefined &&
      viewerUserId != null &&
      environment.ownerUserId === viewerUserId
    );
  }
  return environment.mode === "dedicated" && environment.spaceId === scope.spaceId;
}

/** The Sandbox of the Organization's Space, if the Hub lists one. */
export function sandboxOfScope<T extends Pick<HubEnvironmentSummary, "kind" | "spaceId">>(
  scope: OwnedResourceScope,
  environments: ReadonlyArray<T>,
): T | undefined {
  if (scope.kind !== "organization") return undefined;
  return environments.find(
    (environment) => environment.kind === "sandbox" && environment.spaceId === scope.spaceId,
  );
}

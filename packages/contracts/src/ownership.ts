import * as Schema from "effect/Schema";

import { SpaceId, UserId } from "./baseSchemas.ts";

/**
 * Whose a resource is (owned-resources spec): a User's, used in their Personal space, or an
 * Organization's, used by whoever works there. Machines and AI accounts carry it; Grants lend by it.
 */
export const ResourceOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), userId: UserId }),
  Schema.Struct({ kind: Schema.Literal("organization"), spaceId: SpaceId }),
]);
export type ResourceOwner = typeof ResourceOwner.Type;

/** Whether two owners are the same User or Organization. */
export const sameResourceOwner = (left: ResourceOwner, right: ResourceOwner): boolean =>
  left.kind === "user"
    ? right.kind === "user" && left.userId === right.userId
    : right.kind === "organization" && left.spaceId === right.spaceId;

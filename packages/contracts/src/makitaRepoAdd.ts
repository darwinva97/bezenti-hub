import * as Schema from "effect/Schema";

import { SpaceId } from "./baseSchemas.ts";
import { MakitaProjectRepo } from "./makita.ts";

/**
 * Makita ticket 21: a repository added to a Space by name, from a configuration's form. The Hub
 * reuses the Space's Project with that GitHub remote, or makes one by cloning it as the person.
 */
export const MakitaRepoAddInput = Schema.Struct({
  spaceId: SpaceId,
  /** `owner/name` or a github.com URL. */
  repo: Schema.String,
});
export type MakitaRepoAddInput = typeof MakitaRepoAddInput.Type;

export const MakitaRepoAddResult = Schema.Struct({
  project: MakitaProjectRepo,
  /** False when a Project of the Space already had that repository. */
  created: Schema.Boolean,
  /** What the person should know: a clone that failed, Makita unable to push there. */
  notes: Schema.Array(Schema.String),
});
export type MakitaRepoAddResult = typeof MakitaRepoAddResult.Type;

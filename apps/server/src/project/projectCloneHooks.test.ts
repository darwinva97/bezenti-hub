import { assert, it } from "@effect/vitest";
import { ProjectId, SpaceId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type ProjectCloneHookDeps, projectCloneHooks } from "./projectCloneHooks.ts";

/** What `ProjectService.create` was asked for. */
const recording = () => {
  const created: Array<Record<string, unknown>> = [];
  const deps = {
    projectService: {
      create: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          created.push(input);
          return {} as never;
        }),
    },
    repositoryIdentityResolver: {},
    projectEnrichment: {},
    refreshGitStatus: () => Effect.void,
    verifyDestination: () => Effect.void,
  } as unknown as ProjectCloneHookDeps;
  return { created, deps };
};

const project = {
  projectId: ProjectId.make("cloned-1"),
  title: "widgets",
  workspaceRoot: "/hub/projects/widgets",
  createdAt: "2026-11-25T00:00:00.000Z",
};

it.effect(
  "makes a cloned Project for the session's User, or (Makita ticket 21) in the named Space for the named User",
  () =>
    Effect.gen(function* () {
      const session = recording();
      yield* projectCloneHooks(session.deps).createProject(project);
      assert.equal(session.created.length, 1);
      assert.notProperty(session.created[0], "spaceId");
      assert.notProperty(session.created[0], "actorUserId");
      assert.include(session.created[0], {
        projectId: project.projectId,
        workspaceRoot: project.workspaceRoot,
        createWorkspaceRootIfMissing: true,
      });

      const makita = recording();
      yield* projectCloneHooks(makita.deps, {
        spaceId: SpaceId.make("org-acme"),
        actorUserId: UserId.make("grace"),
      }).createProject(project);
      assert.include(makita.created[0], { spaceId: "org-acme", actorUserId: "grace" });
    }),
);

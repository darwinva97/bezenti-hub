import { CommandId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";

it.effect("lets only the Owner create Organizations, which then show in the Space selector", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const owner = created.cookie ?? "";
    const member = yield* addMember(server);

    const ownerBefore = yield* server.request("/api/spaces", { cookie: owner });
    expect(ownerBefore.body).toMatchObject({
      canCreateOrganization: true,
      isOwner: true,
      // The Owner also lists every other Personal space, to read and not to create in.
      spaces: [
        { kind: "personal", isOwn: true, canCreateThreads: true },
        { kind: "personal", isOwn: false, name: "Grace Hopper", canCreateThreads: false },
      ],
    });

    const acme = yield* server.request("/api/spaces/organizations", {
      body: { name: "Acme" },
      cookie: owner,
    });
    expect(acme.status).toBe(200);
    expect(acme.body).toMatchObject({ kind: "organization", name: "Acme" });
    const refused = yield* server.request("/api/spaces/organizations", {
      body: { name: "Shadow" },
      cookie: member,
    });
    expect(refused.status).toBe(403);

    const ownerAfter = yield* server.request("/api/spaces", { cookie: owner });
    expect((ownerAfter.body.spaces as ReadonlyArray<{ name: string }>).map((s) => s.name)).toEqual([
      "Personal",
      "Acme",
      "Grace Hopper",
    ]);
    // Not a Member of Acme and granted nothing, Grace still has her own Personal space.
    const memberView = yield* server.request("/api/spaces", { cookie: member });
    expect(memberView.body).toMatchObject({ canCreateOrganization: false, isOwner: false });
    expect(memberView.body.spaces).toEqual([
      expect.objectContaining({ kind: "personal", isOwn: true, canCreateThreads: true }),
    ]);
  }),
);

it.effect(
  "stamps a new Project with the requested Space and its creator, whatever the client says",
  () =>
    Effect.gen(function* () {
      const server = yield* serveAuthHttp;
      const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
      const owner = created.cookie ?? "";
      const ownerId = (created.body.user as { id: string }).id;
      const grace = yield* addMember(server);
      const linus = yield* addMember(server, { id: "guest-1", displayName: "Linus" });
      const acme = yield* server.request("/api/spaces/organizations", {
        body: { name: "Acme" },
        cookie: owner,
      });
      const acmeId = acme.body.id as string;
      yield* joinOrganization(server, acmeId, "member-1", "member");
      yield* joinOrganization(server, acmeId, "guest-1", "guest");
      const createProject = (cookie: string, id: string, extra: Record<string, unknown>) =>
        server.request("/api/projects/mutate", {
          cookie,
          body: {
            type: "project.create",
            commandId: `create-${id}`,
            projectId: id,
            title: id,
            workspaceRoot: server.newProjectFolder(id),
            ...extra,
          },
        });

      const inAcme = yield* createProject(grace, "api", { spaceId: acmeId, ownerUserId: ownerId });
      expect(inAcme.status).toBe(200);
      expect(inAcme.body).toMatchObject({ spaceId: acmeId, ownerUserId: "member-1" });
      // With no Space named, the Project lands in the creator's Personal space.
      const personal = yield* createProject(owner, "notes", {});
      expect(personal.body).toMatchObject({
        spaceId: `personal:${ownerId}`,
        ownerUserId: ownerId,
      });
      // The policy is asked on this path: a Guest cannot create Projects.
      expect((yield* createProject(linus, "guest-project", { spaceId: acmeId })).status).toBe(403);
    }),
);

it.effect(
  "stamps a Project created with no User of its own (MCP tools, the CLI) as the Owner's",
  () =>
    Effect.gen(function* () {
      const server = yield* serveAuthHttp;
      const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
      const ownerId = (created.body.user as { id: string }).id;

      const project = yield* server.projects.create({
        commandId: CommandId.make("create-cli"),
        projectId: ProjectId.make("cli"),
        title: "cli",
        workspaceRoot: "/work/cli",
      });
      expect(project).toMatchObject({ spaceId: `personal:${ownerId}`, ownerUserId: ownerId });
    }),
);

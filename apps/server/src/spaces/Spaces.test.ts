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

it.effect(
  "any User creates an Organization, as its Admin, under a name no other Organization has",
  () =>
    Effect.gen(function* () {
      const server = yield* serveAuthHttp;
      const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
      const owner = created.cookie ?? "";
      const ownerId = (created.body.user as { id: string }).id;
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
      // Granted nothing and in no Organization, Grace has her Personal space and may create one.
      const memberBefore = yield* server.request("/api/spaces", { cookie: member });
      expect(memberBefore.body).toMatchObject({ canCreateOrganization: true, isOwner: false });
      expect(memberBefore.body.spaces).toEqual([
        expect.objectContaining({ kind: "personal", isOwn: true, canCreateThreads: true }),
      ]);

      const organization = (cookie: string, name: string) =>
        server.request("/api/spaces/organizations", { body: { name }, cookie });
      const acme = yield* organization(owner, "Acme");
      expect(acme.status).toBe(200);
      expect(acme.body).toMatchObject({ kind: "organization", name: "Acme" });
      // Grace makes her own. She signs in with no passkey or authenticator app, so she is its
      // Admin but acts as a Member until she adds one.
      const shadow = yield* organization(member, "Big   Team");
      expect(shadow.status).toBe(200);
      expect(shadow.body).toMatchObject({
        kind: "organization",
        name: "Big Team",
        role: "member",
        pendingAdmin: true,
        canInvite: false,
      });
      const shadowId = shadow.body.id as string;

      // No two Organizations share a name, whatever its case or spacing.
      for (const [cookie, name] of [
        [member, "acme"],
        [owner, "  ACME "],
        [owner, "big team"],
        [member, "Big  TEAM"],
      ] as const) {
        const taken = yield* organization(cookie, name);
        expect(taken.status, name).toBe(409);
      }

      const memberAfter = yield* server.request("/api/spaces", { cookie: member });
      expect(memberAfter.body.spaces).toEqual([
        expect.objectContaining({ kind: "personal", isOwn: true }),
        expect.objectContaining({
          id: shadowId,
          name: "Big Team",
          role: "member",
          pendingAdmin: true,
        }),
      ]);
      const ownerAfter = yield* server.request("/api/spaces", { cookie: owner });
      expect(
        (ownerAfter.body.spaces as ReadonlyArray<{ name: string }>).map((s) => s.name).toSorted(),
      ).toEqual(["Acme", "Big Team", "Grace Hopper", "Personal"]);

      // The creator is stored with the Organization (the Steward to be) and in the audit log;
      // the Owner holds no Membership of their own.
      const stored = yield* server.sql<{ name: string; createdBy: string | null }>`
        SELECT name, created_by_user_id AS "createdBy" FROM spaces
        WHERE kind = 'organization' ORDER BY name
      `;
      expect(stored.map((row) => ({ ...row }))).toEqual([
        { name: "Acme", createdBy: ownerId },
        { name: "Big Team", createdBy: "member-1" },
      ]);
      const memberships = yield* server.sql<{ spaceId: string; userId: string; role: string }>`
        SELECT space_id AS "spaceId", user_id AS "userId", role FROM space_memberships
      `;
      expect(memberships.map((row) => ({ ...row }))).toEqual([
        { spaceId: shadowId, userId: "member-1", role: "admin" },
      ]);
      const audited = yield* server.sql<{ actor: string; spaceId: string }>`
        SELECT actor_user_id AS "actor", target_id AS "spaceId" FROM audit_log
        WHERE action = 'organization.create' ORDER BY audit_id
      `;
      expect(audited.map((row) => ({ ...row }))).toEqual([
        { actor: ownerId, spaceId: acme.body.id },
        { actor: "member-1", spaceId: shadowId },
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

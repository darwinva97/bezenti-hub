import {
  AuthSessionId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { resolveCliUser } from "../cli/userFlag.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { visibleShells } from "../mcp/mcpVisibility.ts";
import * as ProjectHandlers from "../mcp/toolkits/project/handlers.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as EnvironmentHandlers from "../mcp/toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { CLONE_DESTINATION_REFUSED } from "../project/cloneDestination.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import {
  bootstrapOwner,
  makeAuthenticator,
  type Server,
  serveAuthHttp,
} from "./UserAuth.testkit.ts";

// Outside agents (an MCP client such as Claude Code in a terminal) and `t3` CLI tokens act as
// the User who approved or was chosen for them, never as the Owner.

const PASSWORD = "correct horse battery";
const REDIRECT = "http://localhost:51234/callback";
const VERIFIER = "a".repeat(43) + "-verifier-for-tests";
const CHALLENGE = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";

const threadCreated = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly spaceId: string;
}) => {
  const id = ThreadId.make(input.id);
  const at = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make(input.projectId),
    title: `work ${input.id}`,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    spaceId: SpaceId.make(input.spaceId),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`create-${input.id}`),
    type: "thread.created" as const,
    threadId: id,
    providerInstanceId,
    occurredAt: at,
    payload,
  };
};

/** The Owner with Acme (Member Grace) and Globex (Member Linus), a Project and Thread in each. */
const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const organization = (name: string) =>
    server
      .request("/api/spaces/organizations", { body: { name }, cookie: owner })
      .pipe(Effect.map((response) => response.body.id as string));
  const acme = yield* organization("Acme");
  const globex = yield* organization("Globex");
  const member = Effect.fn(function* (spaceId: string, loginName: string) {
    const invitation = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
      body: { role: "member" },
      cookie: owner,
    });
    const accepted = yield* server.request("/api/invitations/accept", {
      body: {
        token: invitation.body.token,
        method: "password",
        displayName: loginName,
        loginName,
        password: PASSWORD,
      },
    });
    const [row] = yield* server.sql<{ userId: string }>`
      SELECT user_id AS "userId" FROM users WHERE display_name = ${loginName}
    `;
    return { cookie: accepted.cookie ?? "", userId: UserId.make(row!.userId) };
  });
  const grace = yield* member(acme, "grace");
  const linus = yield* member(globex, "linus");
  for (const [id, spaceId] of [
    ["acme-app", acme],
    ["globex-app", globex],
  ] as const) {
    const response = yield* server.request("/api/projects/mutate", {
      cookie: owner,
      body: {
        type: "project.create",
        commandId: `create-${id}`,
        projectId: id,
        title: id,
        workspaceRoot: `/work/${id}`,
        spaceId,
      },
    });
    assert.equal(response.status, 200);
  }
  yield* server.eventSink.write({
    events: [
      threadCreated({ id: "acme-thread", projectId: "acme-app", spaceId: acme }),
      threadCreated({ id: "globex-thread", projectId: "globex-app", spaceId: globex }),
    ],
  });
  return { server, owner, acme, globex, grace, linus };
});

/** An outside MCP client's OAuth flow, approved on the consent page by whoever `cookie` signs in. */
const authorizeClient = Effect.fn(function* (server: Server, cookie: string) {
  const registered = yield* server.request("/oauth/mcp/register", {
    body: { client_name: "Claude Code", redirect_uris: [REDIRECT] },
  });
  assert.equal(registered.status, 201);
  const clientId = registered.body.client_id as string;
  const authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "state-1",
  };
  const details = yield* server.request("/oauth/mcp/approval", { body: authorization, cookie });
  const decision = yield* server.request("/oauth/mcp/decision", {
    cookie,
    body: {
      authorization,
      decision: {
        _tag: "browser-session",
        access: "full-access",
        csrfToken: details.body.csrfToken,
      },
    },
  });
  const code = new URL(decision.body.redirectTo as string).searchParams.get("code") ?? "";
  const token = yield* server.request("/oauth/mcp/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    },
  });
  assert.equal(token.status, 200);
  return { details: details.body, token: token.body.access_token as string };
});

/** What `/mcp` makes of a bearer token: the invocation scope its tools run in. */
const mcpScope = (server: Server, token: string) =>
  Context.get(server.services, McpHttpServer.McpClientAuthenticator).authenticate(
    HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1/mcp", { headers: { authorization: `Bearer ${token}` } }),
    ),
  );

/** Runs one of the project tools as the MCP caller `scope`. */
const callProjectTool = <
  Name extends
    | "t3_project_list"
    | "t3_project_create"
    | "t3_project_update"
    | "t3_project_delete"
    | "t3_project_clone",
>(
  server: Server,
  scope: McpInvocationContext.McpInvocationScope,
  name: Name,
  params: Parameters<Effect.Success<typeof ProjectToolkit>["handle"]>[1],
) => {
  const dependencies = Layer.mergeAll(
    Layer.succeedContext(server.services),
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    // Projects started from a title only are not under test.
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/work" }),
    // A clone that gets past its checks is answered without git.
    Layer.mock(Repositories.SourceControlRepositoryService)({
      cloneRepository: (input) =>
        Effect.succeed({
          cwd: input.destinationPath,
          remoteUrl: "https://example.com/acme/app.git",
          repository: null,
        }),
    }),
  );
  return Effect.gen(function* () {
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const results = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1) as { readonly isFailure: boolean; readonly result: unknown };
  });
};

it.live("an MCP client Grace approves reads and creates as Grace, not as the Owner", () =>
  Effect.gen(function* () {
    const { server, acme, grace } = yield* hub;
    const { details, token } = yield* authorizeClient(server, grace.cookie);
    assert.equal(details.signedInAs, "grace");

    const scope = yield* mcpScope(server, token);
    assert.isDefined(scope);
    assert.equal(scope!.userId, grace.userId);
    // The same principal WS and HTTP authorize by, loaded from the scope's User.
    const principal = yield* Context.get(
      server.services,
      SpaceDirectory.SpaceDirectory,
    ).principalOf(scope!.userId!);
    assert.equal(principal?.isOwner, false);
    assert.deepEqual([...(principal?.roles ?? new Map())], [[SpaceId.make(acme), "member"]]);

    // It lists only the work of Grace's Spaces.
    const listed = yield* callProjectTool(server, scope!, "t3_project_list", {});
    assert.deepEqual(
      (listed.result as { projects: ReadonlyArray<{ id: string }> }).projects.map(
        (project) => project.id,
      ),
      ["acme-app"],
    );
    const shells = (yield* Context.get(
      server.services,
      ThreadManagement.ThreadManagementService,
    ).getShellSnapshot()).threads;
    const visible = yield* visibleShells(scope!, shells).pipe(
      Effect.provide(Layer.succeedContext(server.services)),
    );
    assert.deepEqual(
      visible.map((shell) => shell.id),
      ["acme-thread"],
    );

    // A new Project lands in Grace's own Personal space, never in the Owner's.
    const sideRoot = server.newProjectFolder("side");
    const created = yield* callProjectTool(server, scope!, "t3_project_create", {
      title: "Side project",
      workspaceRoot: sideRoot,
    });
    assert.isFalse(created.isFailure, JSON.stringify(created.result));
    const rows = yield* server.sql<{ spaceId: string; ownerUserId: string }>`
      SELECT space_id AS "spaceId", owner_user_id AS "ownerUserId" FROM projection_projects
      WHERE workspace_root = ${sideRoot}
    `;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ spaceId: `personal:${grace.userId}`, ownerUserId: grace.userId }],
    );

    // A Project in a Space Grace cannot see cannot be changed or deleted: it reads as missing.
    for (const [tool, params] of [
      ["t3_project_update", { projectId: "globex-app", title: "Renamed" }],
      ["t3_project_delete", { projectId: "globex-app", force: true }],
    ] as const) {
      const hidden = yield* callProjectTool(server, scope!, tool, params as never);
      assert.isTrue(hidden.isFailure, tool);
      assert.include(JSON.stringify(hidden.result), "The project was not found.");
    }
    const globex = yield* server.sql<{ title: string; deletedAt: string | null }>`
      SELECT title, deleted_at AS "deletedAt" FROM projection_projects WHERE project_id = 'globex-app'
    `;
    assert.deepEqual(globex, [{ title: "globex-app", deletedAt: null }]);
  }),
);

it.live("removing Grace revokes the MCP clients she approved", () =>
  Effect.gen(function* () {
    const { server, owner, grace } = yield* hub;
    const { token } = yield* authorizeClient(server, grace.cookie);
    assert.equal((yield* mcpScope(server, token))?.userId, grace.userId);
    const removed = yield* server.request(`/api/installation/users/${grace.userId}/status`, {
      body: { status: "removed" },
      cookie: owner,
    });
    assert.equal(removed.status, 200);
    assert.isUndefined(yield* mcpScope(server, token));
    const live = yield* server.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM auth_sessions
      WHERE user_id = ${grace.userId} AND revoked_at IS NULL
    `;
    assert.equal(live[0]?.count, 0);
  }),
);

it.live("the client shows in Grace's sessions, Grace can revoke it, and others cannot", () =>
  Effect.gen(function* () {
    const { server, owner, grace, linus } = yield* hub;
    const { token } = yield* authorizeClient(server, grace.cookie);
    const scope = yield* mcpScope(server, token);
    const clientSessionId = AuthSessionId.make(scope!.client!.sessionId);

    const sessionsOf = (cookie: string) =>
      server.sessions.verify(cookie.split("=")[1] ?? "").pipe(
        Effect.flatMap(server.environmentAuth.listClientSessions),
        Effect.map((sessions) => sessions.map((session) => session.sessionId)),
      );
    assert.include(yield* sessionsOf(grace.cookie), clientSessionId);
    assert.notInclude(yield* sessionsOf(linus.cookie), clientSessionId);
    assert.include(yield* sessionsOf(owner), clientSessionId);

    const revoke = (cookie: string) =>
      server.request("/api/auth/clients/revoke", { body: { sessionId: clientSessionId }, cookie });
    assert.equal((yield* revoke(linus.cookie)).status, 403);
    assert.deepEqual((yield* revoke(grace.cookie)).body, { revoked: true });
    assert.isUndefined(yield* mcpScope(server, token));
  }),
);

it.live("a pairing code Grace created approves a client that acts as Grace", () =>
  Effect.gen(function* () {
    const { server, grace } = yield* hub;
    const code = yield* server.request("/api/auth/pairing-token", {
      body: { label: "Claude Code" },
      cookie: grace.cookie,
    });
    const registered = yield* server.request("/oauth/mcp/register", {
      body: { client_name: "Claude Code", redirect_uris: [REDIRECT] },
    });
    const authorization = {
      response_type: "code",
      client_id: registered.body.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    };
    // A signed-out browser: no csrfToken, so the page asks to sign in or for a code.
    const details = yield* server.request("/oauth/mcp/approval", { body: authorization });
    assert.isUndefined(details.body.csrfToken);
    const decision = yield* server.request("/oauth/mcp/decision", {
      body: {
        authorization,
        decision: { _tag: "pairing-code", access: "read-only", code: code.body.credential },
      },
    });
    const token = yield* server.request("/oauth/mcp/token", {
      form: {
        grant_type: "authorization_code",
        code: new URL(decision.body.redirectTo as string).searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        client_id: authorization.client_id,
        code_verifier: VERIFIER,
      },
    });
    const scope = yield* mcpScope(server, token.body.access_token as string);
    assert.equal(scope?.userId, grace.userId);
  }),
);

it.live(
  "`t3 auth session issue --user grace`, `t3 pair --user grace` and `t3 thread --user grace` act as Grace",
  () =>
    Effect.gen(function* () {
      const { server, owner, grace } = yield* hub;
      const chosen = yield* resolveCliUser(Option.some("grace")).pipe(
        Effect.provide(Layer.succeedContext(server.services)),
      );
      assert.equal(chosen, grace.userId);
      assert.isUndefined(
        yield* resolveCliUser(Option.none()).pipe(
          Effect.provide(Layer.succeedContext(server.services)),
        ),
      );
      const unknown = yield* resolveCliUser(Option.some("nobody")).pipe(
        Effect.provide(Layer.succeedContext(server.services)),
        Effect.flip,
      );
      assert.equal(unknown._tag, "CliUnknownUserError");

      // `t3 auth session issue --user grace`: a bearer token that reads Grace's work only.
      const issued = yield* server.environmentAuth.issueSession({ userId: chosen! });
      const shell = yield* server.request("/api/orchestration/shell", {
        authorization: `Bearer ${issued.token}`,
      });
      assert.deepEqual(
        (shell.body.projects as ReadonlyArray<{ id: string }>).map((project) => project.id),
        ["acme-app"],
      );
      const ownerShell = yield* server.request("/api/orchestration/shell", { cookie: owner });
      assert.lengthOf(ownerShell.body.projects as ReadonlyArray<unknown>, 2);

      // `t3 pair --user grace`: the device that pairs signs in as Grace.
      const link = yield* server.environmentAuth.createPairingLink({ userId: chosen! });
      const paired = yield* server.request("/api/auth/browser-session", {
        body: { credential: link.credential },
      });
      const session = yield* server.request("/api/auth/session", { cookie: paired.cookie ?? "" });
      assert.equal(session.body.userId, grace.userId);

      // `t3 thread --user grace`: its MCP session acts as Grace.
      const thread = yield* server.environmentAuth.issueMcpClientSession({
        label: "t3 thread cli",
        userId: chosen!,
        access: "full-access",
        client: { deviceType: "bot", ipAddress: "127.0.0.1" },
      });
      assert.equal((yield* mcpScope(server, thread.token))?.userId, grace.userId);

      // A User who can no longer sign in gets no token.
      yield* server.sql`UPDATE users SET disabled_at = '2026-11-02T00:00:00.000Z' WHERE user_id = ${grace.userId}`;
      const refused = yield* server.environmentAuth
        .issueSession({ userId: chosen! })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "ServerAuthInvalidCredentialError");
      assert.isTrue(EnvironmentAuth.isServerAuthCredentialError(refused));
    }),
);

it.live(
  "a signed-in User cannot approve with someone else's code, and a disabled creator's code stays unspent",
  () =>
    Effect.gen(function* () {
      const { server, grace } = yield* hub;
      const registered = yield* server.request("/oauth/mcp/register", {
        body: { client_name: "Claude Code", redirect_uris: [REDIRECT] },
      });
      const authorization = {
        response_type: "code",
        client_id: registered.body.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      };
      const approveWith = (code: string, cookie?: string) =>
        server.request("/oauth/mcp/decision", {
          ...(cookie === undefined ? {} : { cookie }),
          body: { authorization, decision: { _tag: "pairing-code", access: "read-only", code } },
        });
      const spendable = (code: string) =>
        server.sql<{ spent: number }>`
        SELECT consumed_at IS NOT NULL AS spent FROM auth_pairing_links WHERE credential = ${code}
      `.pipe(Effect.map((rows) => rows[0]?.spent === 0));

      // The Owner's code pasted into Grace's signed-in browser would act as the Owner.
      const ownerCode = (yield* server.environmentAuth.createPairingLink()).credential;
      const refused = yield* approveWith(ownerCode, grace.cookie);
      assert.equal(refused.status, 400);
      assert.include(refused.body.message as string, "another account");
      assert.isTrue(yield* spendable(ownerCode));

      // A code whose creator can no longer sign in is refused before it is spent.
      const graceCode = (yield* server.request("/api/auth/pairing-token", {
        body: { label: "Claude Code" },
        cookie: grace.cookie,
      })).body.credential as string;
      yield* server.sql`UPDATE users SET disabled_at = '2026-11-02T00:00:00.000Z' WHERE user_id = ${grace.userId}`;
      const inactive = yield* approveWith(graceCode);
      assert.equal(inactive.status, 400);
      assert.include(inactive.body.message as string, "can no longer sign in");
      assert.isTrue(yield* spendable(graceCode));
    }),
);

it.live("a signed-in session that cannot approve is named, so the page can say why", () =>
  Effect.gen(function* () {
    const { server, grace } = yield* hub;
    const narrow = yield* server.sessions.issue({
      method: "browser-session-cookie",
      subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
      userId: grace.userId,
      scopes: ["orchestration:read"],
    });
    const registered = yield* server.request("/oauth/mcp/register", {
      body: { client_name: "Claude Code", redirect_uris: [REDIRECT] },
    });
    const details = yield* server.request("/oauth/mcp/approval", {
      cookie: `${server.sessions.cookieName}=${narrow.token}`,
      body: {
        response_type: "code",
        client_id: registered.body.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      },
    });
    assert.isUndefined(details.body.csrfToken);
    assert.equal(details.body.signedInAs, "grace");
  }),
);

it.live("an MCP client approved before the Owner existed becomes the Owner's", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const early = yield* server.environmentAuth.issueMcpClientSession({
      label: "Claude Code",
      access: "read-only",
      client: { deviceType: "bot", ipAddress: "127.0.0.1" },
    });
    assert.isUndefined((yield* mcpScope(server, early.token))?.userId);
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const ownerId = (created.body.user as { id: string }).id;
    assert.equal((yield* mcpScope(server, early.token))?.userId, ownerId);
  }),
);

/** Runs the environment preferences tool as the MCP caller `scope`. */
const callEnvironmentTool = (
  server: Server,
  scope: McpInvocationContext.McpInvocationScope,
  params: Parameters<Effect.Success<typeof EnvironmentToolkit>["handle"]>[1],
) => {
  const dependencies = Layer.mergeAll(
    Layer.succeedContext(server.services),
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({ environmentId: scope.environmentId } as never),
    }),
    Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
  );
  return Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const results = yield* toolkit
      .handle("t3_environment_preferences_update", params as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1) as { readonly isFailure: boolean; readonly result: unknown };
  });
};

it.live(
  "an MCP client of a Member changes none of the Installation's settings, scripts or folders",
  () =>
    Effect.gen(function* () {
      const { server, owner, grace } = yield* hub;
      const asGrace = (yield* mcpScope(
        server,
        (yield* authorizeClient(server, grace.cookie)).token,
      ))!;
      const asOwner = (yield* mcpScope(server, (yield* authorizeClient(server, owner)).token))!;
      const environment = (scope: McpInvocationContext.McpInvocationScope, params: unknown) =>
        callEnvironmentTool(server, scope, params as never);
      const project = (
        scope: McpInvocationContext.McpInvocationScope,
        name: "t3_project_update" | "t3_project_clone",
        params: unknown,
      ) => callProjectTool(server, scope, name, params as never);
      const refusal = (outcome: { readonly isFailure: boolean; readonly result: unknown }) =>
        outcome.isFailure ? JSON.stringify(outcome.result) : "";

      // The Installation's settings are the Owner's, as from the app.
      const settings = Context.get(server.services, ServerSettings.ServerSettingsService);
      const before = (yield* settings.getSettings).enableProviderUpdateChecks;
      assert.include(
        refusal(yield* environment(asGrace, { enableProviderUpdateChecks: !before })),
        "Only the Owner of this Hub can do that.",
      );
      assert.equal((yield* settings.getSettings).enableProviderUpdateChecks, before);
      assert.equal(
        refusal(yield* environment(asOwner, { enableProviderUpdateChecks: before })),
        "",
      );

      // A Project's scripts need the settings scope, which only the Owner's sessions hold.
      const scripts = [
        { id: "build", name: "Build", command: "make", icon: "play", runOnWorktreeCreate: false },
      ];
      assert.include(
        refusal(yield* project(asGrace, "t3_project_update", { projectId: "acme-app", scripts })),
        "settings:write",
      );
      assert.equal(
        refusal(yield* project(asOwner, "t3_project_update", { projectId: "acme-app", scripts })),
        "",
      );

      // Clones go where the Member may work, as from the app.
      const clone = (scope: McpInvocationContext.McpInvocationScope, destinationPath: string) =>
        project(scope, "t3_project_clone", {
          remoteUrl: "https://example.com/acme/app.git",
          destinationPath,
        });
      for (const outside of ["/etc/cron.d/app", "/work/globex-app/node_modules/app", "/work/a/b"]) {
        assert.include(refusal(yield* clone(asGrace, outside)), CLONE_DESTINATION_REFUSED, outside);
      }
      assert.equal(refusal(yield* clone(asGrace, "/work/new-app")), "");
      assert.equal(refusal(yield* clone(asGrace, "/work/acme-app/vendor/lib")), "");
      assert.equal(refusal(yield* clone(asOwner, "/etc/owner-app")), "");
    }),
);

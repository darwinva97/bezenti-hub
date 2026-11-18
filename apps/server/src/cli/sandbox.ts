// @effect-diagnostics nodeBuiltinImport:off -- whether this machine joined a Hub.
/**
 * `t3 sandbox image build`: builds the Sandboxes' base image. With this Hub running it asks the Hub
 * (which builds it, as Settings does) and follows its output; otherwise it builds it here and
 * records the build in the Hub's audit log. See docs/internals/sandboxes.md, «Base image».
 */
import * as NodeFS from "node:fs";

import {
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  HUB_MACHINE_ENVIRONMENT_ID,
  type SandboxImageStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SandboxImage from "../sandboxes/SandboxImage.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { sandboxDoctorCommand } from "./sandboxDoctor.ts";

const userError = (message: string) => new CliError.UserError({ cause: message });
const isConflict = Schema.is(EnvironmentHttpConflictError);
const isUserError = Schema.is(CliError.UserError);

const builtMessage = (status: SandboxImageStatus) =>
  [
    `Built ${status.image.image} (${status.image.version ?? "unknown version"}).`,
    "Stopped Sandboxes run it from their next start; move running ones in Settings → Environments.",
    ...(status.runsPodmanSandboxes ? [] : ["Restart the Hub to run its Sandboxes from it."]),
  ].join("\n");

/** The Hub did not answer at all (it is not running): the build happens here instead. */
const unreachable = (error: unknown) =>
  (HttpClientError.isHttpClientError(error) && error.response === undefined) ||
  Cause.isTimeoutError(error);

/**
 * Asks the running Hub to build it (or follows the build under way) and prints its output. False
 * when no Hub answers there.
 */
const buildOnHub = Effect.fn("cli.sandbox.buildOnHub")(function* (origin: string, token: string) {
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
  const headers = { authorization: `Bearer ${token}` };
  const probe = yield* client.sandboxImage
    .status({ headers, query: {} })
    .pipe(Effect.timeout("3 seconds"), Effect.result);
  if (probe._tag === "Failure") {
    if (unreachable(probe.failure)) return false;
    return yield* userError(`The Hub refused: ${errorText(probe.failure)}`);
  }
  let status = yield* client.sandboxImage
    .build({ headers })
    .pipe(
      Effect.catchIf(isConflict, () =>
        Console.log("A build is already under way on the Hub; following it.").pipe(
          Effect.andThen(client.sandboxImage.status({ headers, query: {} })),
        ),
      ),
    );
  // Each poll answers only the lines after the ones already printed.
  while (true) {
    for (const line of status.build.log) yield* Console.log(line);
    if (status.build.state !== "building") break;
    yield* Effect.sleep("1 second");
    status = yield* client.sandboxImage.status({
      headers,
      query: { after: status.build.logLines },
    });
  }
  if (status.build.state === "failed") {
    return yield* userError(`The Sandbox image was not built: ${status.build.error ?? "unknown"}`);
  }
  yield* Console.log(builtMessage(status));
  return true;
});

const errorText = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

/**
 * A joined machine (a dedicated one runs its Sandbox here) builds its own image in this process,
 * whether or not its server runs: that server serves only `/health`; the audit log is the Hub's.
 */
const buildOnJoinedMachine = Effect.fn("cli.sandbox.buildOnJoinedMachine")(function* () {
  const image = yield* SandboxImage.configuredSandboxImage;
  const built = yield* SandboxImage.buildSandboxImage({
    image,
    onLine: (line) => process.stdout.write(`${line}\n`),
  }).pipe(Effect.mapError((error) => userError(error.message)));
  yield* Console.log(
    `Built ${image} (${built.version}). This machine's Sandbox runs it from its next start; one that was waiting for the image starts within 15 seconds (its \`t3 serve\` asks Podman again).`,
  );
});

/** No Hub running: builds it in this process, then records it as the Hub would. */
const buildHere = Effect.fn("cli.sandbox.buildHere")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  // An unreachable server may still be running; never write behind it.
  yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.mapError((error) => userError(error.message)),
  );
  const image = yield* SandboxImage.configuredSandboxImage;
  const built = yield* SandboxImage.buildSandboxImage({
    image,
    onLine: (line) => process.stdout.write(`${line}\n`),
  }).pipe(Effect.result);
  yield* Effect.gen(function* () {
    const audit = yield* AuditLog.AuditLog;
    yield* audit.record({
      actor: AuditLog.cliActor,
      action: "sandbox.image.update",
      target: { kind: "environment", id: HUB_MACHINE_ENVIRONMENT_ID, name: image },
      detail:
        built._tag === "Success"
          ? { via: "cli", outcome: "built", version: built.success.version }
          : { via: "cli", outcome: "failed", reason: built.failure.detail.slice(0, 200) },
    });
  }).pipe(
    Effect.provide(
      AuditLog.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerConfig),
        Layer.provideMerge(ServerConfig.layer(config)),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record the build in the audit log", { cause }),
    ),
  );
  if (built._tag === "Failure") return yield* userError(built.failure.message);
  yield* Console.log(
    `Built ${image} (${built.success.version}). Sandboxes run it from their next start.`,
  );
});

const buildCommand = Command.make("build", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Build the Sandboxes' base image with Podman: Node, git, the providers' CLIs and this T3 server.",
  ),
  Command.withHandler(
    Effect.fn("cli.sandbox.image.build")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      if (NodeFS.existsSync(config.joinedHubPath)) return yield* buildOnJoinedMachine();
      return yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        if (Option.isSome(runtimeState)) {
          const origin = runtimeState.value.origin;
          const builtOnHub = yield* Effect.acquireUseRelease(
            environmentAuth.issueSession({
              scopes: AuthStandardClientScopes,
              label: "t3 sandbox image build",
              // What it does is recorded as the shell's, not the Owner's.
              subject: CommandActor.SHELL_SESSION_SUBJECT,
            }),
            (issued) => buildOnHub(origin, issued.token),
            (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore),
          ).pipe(
            Effect.catchIf(
              (error) => !isUserError(error),
              (error) => Effect.fail(userError(`The Hub refused: ${errorText(error)}`)),
            ),
          );
          if (builtOnHub) return;
        }
        return yield* buildHere(config);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
    }),
  ),
);

export const sandboxCommand = Command.make("sandbox").pipe(
  Command.withDescription("Manage this Hub's Sandboxes."),
  Command.withSubcommands([
    sandboxDoctorCommand,
    Command.make("image").pipe(
      Command.withDescription("The base image every Sandbox runs."),
      Command.withSubcommands([buildCommand]),
    ),
  ]),
);

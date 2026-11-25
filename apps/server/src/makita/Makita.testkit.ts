/**
 * Makita's services over the AI gateway testkit's Hub (Ada, Admin; Grace, Member; Linus, Guest of
 * Acme; Gus of Globex) and a fake GitHub. Each test gets its own Hub and its own fake. The
 * Thread launch and the secret masker are recorders: what Makita asked for, as whom.
 */
import type { OrchestrationV2ServerCommand, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { hub } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import * as MakitaAccount from "./MakitaAccount.ts";
import * as MakitaConfigs from "./MakitaConfigs.ts";
import * as MakitaGitHub from "./MakitaGitHub.ts";
import { makeFakeGitHub } from "./MakitaGitHub.testkit.ts";
import * as MakitaIntake from "./MakitaIntake.ts";
import * as MakitaPermissions from "./MakitaPermissions.ts";
import * as MakitaStops from "./MakitaStops.ts";
import * as MakitaTasks from "./MakitaTasks.ts";

/** One `ThreadLaunchService.launch` Makita asked for, and the actor it ran as. */
export interface RecordedLaunch {
  readonly input: ThreadLaunchService.ThreadLaunchInput;
  readonly actor: CommandActor.Actor;
}

/** A Thread command Makita sent (ticket 06: a stopped task's turn interrupted), and as whom. */
export interface RecordedCommand {
  readonly command: OrchestrationV2ServerCommand;
  readonly actor: CommandActor.Actor;
}

/** A message Makita sent to a task's Thread (ticket 09: a mention woke it), and as whom. */
export interface RecordedSend {
  readonly input: ThreadManagementService.ThreadManagementSendInput;
  readonly actor: CommandActor.Actor;
}

export const makitaHub = Effect.gen(function* () {
  const setup = yield* hub;
  const github = makeFakeGitHub();
  const launches: Array<RecordedLaunch> = [];
  const launchState = { fail: false };
  /** Values the creator's Threads hold: the masker replaces each with `[MASKED]`. */
  const creatorSecrets: Array<string> = [];
  const launcher = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: (input) =>
      Effect.gen(function* () {
        const actor = yield* CommandActor.resolve;
        launches.push({ input, actor });
        if (launchState.fail) return yield* Effect.die("launch refused in the test");
        return { threadId: input.threadId as ThreadId } as never;
      }),
  });
  const commands: Array<RecordedCommand> = [];
  const sends: Array<RecordedSend> = [];
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: (command) =>
      Effect.gen(function* () {
        commands.push({ command, actor: yield* CommandActor.resolve });
        return {} as never;
      }),
    sendToThread: (input) =>
      Effect.gen(function* () {
        sends.push({ input, actor: yield* CommandActor.resolve });
        return {} as never;
      }),
  });
  const masker = Layer.mock(SecretMasker.SecretMasker)({
    forUser: () =>
      Effect.succeed({
        isEmpty: creatorSecrets.length === 0,
        mask: (text: string) =>
          creatorSecrets.reduce((masked, value) => masked.split(value).join("[MASKED]"), text),
      } as never),
  });
  const context = yield* Layer.build(
    Layer.mergeAll(MakitaTasks.layer, MakitaStops.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          MakitaAccount.layer,
          MakitaPermissions.layer,
          MakitaConfigs.layer,
          MakitaIntake.layer,
        ),
      ),
      Layer.provide(Layer.mergeAll(launcher, masker, threads)),
      Layer.provideMerge(MakitaGitHub.layer),
      Layer.provide(github.layer),
      Layer.provide(ProcessRunner.layer),
      Layer.provide(Layer.succeedContext(Context.merge(setup.server.services, setup.context))),
    ),
  );
  return {
    ...setup,
    github,
    launches,
    commands,
    sends,
    launchState,
    creatorSecrets,
    makitaAccount: Context.get(context, MakitaAccount.MakitaAccount),
    makitaPermissions: Context.get(context, MakitaPermissions.MakitaPermissions),
    makitaConfigs: Context.get(context, MakitaConfigs.MakitaConfigs),
    makitaIntake: Context.get(context, MakitaIntake.MakitaIntake),
    makitaTasks: Context.get(context, MakitaTasks.MakitaTasks),
    makitaStops: Context.get(context, MakitaStops.MakitaStops),
  };
});

export type MakitaHub = Effect.Success<typeof makitaHub>;

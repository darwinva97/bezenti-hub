/**
 * Makita's services over the AI gateway testkit's Hub (Ada, Admin; Grace, Member; Linus, Guest of
 * Acme; Gus of Globex) and a fake GitHub. Each test gets its own Hub and its own fake.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { hub } from "../ai/AiGatewayRoute.testkit.ts";
import * as MakitaAccount from "./MakitaAccount.ts";
import * as MakitaGitHub from "./MakitaGitHub.ts";
import { makeFakeGitHub } from "./MakitaGitHub.testkit.ts";

export const makitaHub = Effect.gen(function* () {
  const setup = yield* hub;
  const github = makeFakeGitHub();
  const context = yield* Layer.build(
    MakitaAccount.layer.pipe(
      Layer.provideMerge(MakitaGitHub.layer),
      Layer.provide(github.layer),
      Layer.provide(Layer.succeedContext(Context.merge(setup.server.services, setup.context))),
    ),
  );
  return {
    ...setup,
    github,
    makitaAccount: Context.get(context, MakitaAccount.MakitaAccount),
  };
});

export type MakitaHub = Effect.Success<typeof makitaHub>;

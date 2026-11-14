/**
 * OpenAI's `developer` role through the AI gateway: an OpenAI-compatible upstream (DeepSeek,
 * OpenRouter…) knows the Chat Completions roles only and refuses `developer` (422), which is what
 * Codex sends. The Hub asks such an account with `system` instead; an OpenAI account is asked as is.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { acmeSetup, call, hub, platform, posix, PROMPT } from "./AiGatewayRoute.testkit.ts";

const withDeveloper = [
  { role: "developer", content: "Follow the house rules." },
  { role: "user", content: PROMPT },
];

it.live.skipIf(!posix || platform === undefined)(
  "asks an OpenAI-compatible account with `system` where the client said `developer`, and OpenAI as is",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const codex = yield* setup.account("Acme Codex", "codex", { spaceIds: [setup.acmeId] });
      const { key } = yield* setup.thread(setup.people.member, setup.acmeId);

      // Codex speaks Responses: its instructions travel as a `developer` item of `input`.
      const responses = yield* call(setup, "/api/ai/openai/v1/responses", {
        key,
        body: { model: "deepseek-chat", input: withDeveloper },
      });
      assert.equal(responses.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.router}/deepseek-chat`);
      assert.deepEqual(setup.upstream().at(-1)!.roles, ["system", "user"]);

      const chat = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: { model: "deepseek-chat", messages: withDeveloper },
      });
      assert.equal(chat.status, 200);
      assert.deepEqual(setup.upstream().at(-1)!.roles, ["system", "user"]);

      // An OpenAI account knows `developer`: nothing is rewritten for it.
      const openai = yield* call(setup, "/api/ai/openai/v1/responses", {
        key,
        body: { model: "gpt-5.5", input: withDeveloper },
      });
      assert.equal(openai.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${codex}/gpt-5.5`);
      assert.deepEqual(setup.upstream().at(-1)!.roles, ["developer", "user"]);
    }).pipe(Effect.scoped),
);

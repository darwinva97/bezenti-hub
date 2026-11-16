// @effect-diagnostics nodeBuiltinImport:off -- the fake `op` reads the template the driver wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";

import { readError, readValue } from "@t3tools/secret-provider-core/server/driver";

import { OnePasswordAccount } from "../shared/definition.ts";
import { driver } from "./driver.ts";

const encoder = new TextEncoder();
const account = OnePasswordAccount.make("my.1password.com");

type OpResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
};

function fakeOp(answer: (args: ReadonlyArray<string>) => OpResult) {
  const invocations: Array<ReadonlyArray<string>> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
          invocations.push(args);
          Deferred.doneUnsafe(spawned, Effect.void);
          const result = answer(args);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: result.hang
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(result.stdout ?? "")),
            stderr: Stream.make(encoder.encode(result.stderr ?? "")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    NodeFileSystem.layer,
    NodeCrypto.layer,
  );
  return { layer, invocations, spawned };
}

// Answers `op inject` by substituting each `{{ reference }}` in the template file it was handed.
const injectFrom =
  (secrets: Readonly<Record<string, string>>) =>
  (args: ReadonlyArray<string>): OpResult => {
    const template = NodeFS.readFileSync(args[args.indexOf("-i") + 1]!, "utf8");
    return { stdout: template.replace(/\{\{ (\S+) \}\}/g, (_, reference) => secrets[reference]!) };
  };

const value = readValue;
const failed = readError;

describe("1Password driver", () => {
  it.effect("reads one reference from the account", () => {
    const op = fakeOp(() => ({ stdout: "sk-live" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        value("sk-live"),
      ]);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "read",
          "--account=my.1password.com",
          "--no-newline",
          "op://Private/OpenAI/credential",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads a failed reference as not found, never with what `op` said", () => {
    // `op` may echo what it holds: none of its output leaves the driver.
    const op = fakeOp(() => ({
      code: 1,
      stdout: "sk-echoed-secret",
      stderr: "[ERROR] account is locked; sk-echoed-secret",
    }));
    return Effect.gen(function* () {
      const results = yield* driver.read({ account }, ["op://Private/OpenAI/credential"]);
      assert.deepStrictEqual(results, [failed("not-found")]);
      assert.notInclude(JSON.stringify(results), "sk-echoed-secret");
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads an empty answer as not found", () => {
    const op = fakeOp(() => ({ stdout: "  " }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        failed("not-found"),
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("tests the account with `op whoami`, without its text", () => {
    const op = fakeOp((args) =>
      args.includes("whoami") ? { stdout: "URL: x\nEmail: me@x" } : { code: 1 },
    );
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.test({ account }), { ok: true });
      assert.deepStrictEqual(op.invocations, [
        ["--cache=false", "whoami", "--account=my.1password.com"],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("a failed test says forbidden, never what `op` said", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "[ERROR] not signed in" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.test({ account }), { ok: false, error: "forbidden" });
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads every reference in a single call", () => {
    const op = fakeOp(
      injectFrom({
        "op://Private/OpenAI/credential": "sk-a",
        "op://Private/Anthropic/key": " sk-b\n",
      }),
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Anthropic/key",
      ]);

      assert.deepStrictEqual(values, [value("sk-a"), value(" sk-b\n")]);
      assert.strictEqual(op.invocations.length, 1);
      assert.deepStrictEqual(op.invocations[0]?.slice(0, 3), [
        "--cache=false",
        "inject",
        "--account=my.1password.com",
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("falls back to one read at a time when the batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, stderr: '[ERROR] could not resolve "op://Private/Gone/key"' }
        : args.at(-1) === "op://Private/Gone/key"
          ? { code: 1, stderr: "[ERROR] item not found" }
          : { stdout: "sk-a" },
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Gone/key",
      ]);

      assert.deepStrictEqual(values, [value("sk-a"), failed("not-found")]);
      assert.strictEqual(op.invocations.length, 3);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("does not read one at a time after the batch times out", () => {
    const op = fakeOp(() => ({ hang: true }));
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.forkChild);
      yield* Deferred.await(op.spawned);
      yield* TestClock.adjust("1 minute");

      assert.deepStrictEqual(yield* Fiber.join(reading), [
        failed("unavailable"),
        failed("unavailable"),
      ]);
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });
});

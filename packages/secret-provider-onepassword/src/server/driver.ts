import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  defineSecretProviderDriver,
  readError,
  readValue,
  type SecretProviderTestReport,
  type SecretReadResult,
} from "@t3tools/secret-provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/process";

import { definition, type OnePasswordAccount } from "../shared/definition.ts";

const ONE_PASSWORD_BINARY = "op";
// Bounds a read long enough to reach for a fingerprint reader, short enough not to wedge a rebuild.
const READ_TIMEOUT = Duration.seconds(45);

// `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
const runOnePassword = Effect.fn("OnePasswordDriver.runOnePassword")(function* (
  args: ReadonlyArray<string>,
) {
  const spawnCommand = yield* resolveSpawnCommand(ONE_PASSWORD_BINARY, ["--cache=false", ...args]);
  return yield* spawnAndCollect(
    ONE_PASSWORD_BINARY,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, { shell: spawnCommand.shell }),
  );
});

// A secret is passed on verbatim; surrounding whitespace can be part of it. An empty answer is
// one 1Password does not hold. `op` does not tell a missing item from a refused one: not-found.
const toResult = (value: string): SecretReadResult =>
  value.trim().length > 0 ? readValue(value) : readError("not-found");

const readOne = Effect.fn("OnePasswordDriver.readOne")(function* (
  account: OnePasswordAccount,
  reference: string,
) {
  const result = yield* runOnePassword(["read", `--account=${account}`, "--no-newline", reference]);
  if (result.code !== 0) {
    // The exit code only: `op`'s output can echo what it holds.
    yield* Effect.logWarning("Could not read secret from 1Password", {
      stage: "read",
      exitCode: result.code,
    });
    return readError("not-found");
  }
  return toResult(result.stdout);
});

// One `op inject` costs one unlock for every reference in the template. `op` ignores piped stdin
// from Node, so the template goes through a temp file. A random separator after every reference
// keeps one secret from shifting the others, and leaves any trailing newline outside the values.
const readTogether = Effect.fn("OnePasswordDriver.readTogether")(function* (
  account: OnePasswordAccount,
  references: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const separator = `__t3-secret-${yield* (yield* SecureRandom.SecureRandom).uuidV4()}__`;
  const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-inject-" });
  yield* fileSystem.writeFileString(
    templatePath,
    references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
  );
  const result = yield* runOnePassword(["inject", `--account=${account}`, "-i", templatePath]);
  const values = result.stdout.split(separator);
  const trailing = values.pop();
  if (
    result.code !== 0 ||
    values.length !== references.length ||
    trailing === undefined ||
    trailing.trim().length > 0
  ) {
    yield* Effect.logWarning("Could not batch-read secrets from 1Password", {
      stage: "inject",
      exitCode: result.code,
      references: references.length,
    });
    return undefined;
  }
  return values.map(toResult);
}, Effect.scoped);

/** `None` when 1Password did not answer in time; `Some(onFailure)` when `op` could not run. */
const bounded = <A, E extends { readonly _tag: string }, R>(
  stage: "read" | "inject" | "whoami",
  effect: Effect.Effect<A, E, R>,
  onFailure: A,
) =>
  effect.pipe(
    Effect.timeoutOption(READ_TIMEOUT),
    Effect.tap((outcome) =>
      Option.isNone(outcome)
        ? Effect.logWarning("1Password did not answer in time", { stage })
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage, error: error._tag }).pipe(
        Effect.as(Option.some(onFailure)),
      ),
    ),
  );

const UNAVAILABLE = readError("unavailable");

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  read: Effect.fn("OnePasswordDriver.read")(function* ({ account }, references) {
    if (references.length > 1) {
      const together = yield* bounded("inject", readTogether(account, references), undefined);
      // Reading one by one after a timeout would only wait that long again for each reference.
      if (Option.isNone(together)) return references.map(() => UNAVAILABLE);
      if (together.value !== undefined) return together.value;
    }
    return yield* Effect.forEach(references, (reference) =>
      bounded("read", readOne(account, reference), UNAVAILABLE).pipe(
        Effect.map(Option.getOrElse(() => UNAVAILABLE)),
      ),
    );
  }),
  // Signed in to the account, or not: `op`'s text never leaves.
  test: Effect.fn("OnePasswordDriver.test")(function* ({ account }) {
    const outcome = yield* bounded(
      "whoami",
      runOnePassword(["whoami", `--account=${account}`]).pipe(
        Effect.map((result): SecretProviderTestReport =>
          result.code === 0 ? { ok: true } : { ok: false, error: "forbidden" },
        ),
      ),
      { ok: false, error: "unavailable" },
    );
    return Option.getOrElse(outcome, (): SecretProviderTestReport => ({
      ok: false,
      error: "unavailable",
    }));
  }),
});

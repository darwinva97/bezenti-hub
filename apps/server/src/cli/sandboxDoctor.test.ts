import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";

import type { FixPlan } from "../sandboxes/hostDoctorReport.ts";
import { applyFix } from "./sandboxDoctor.ts";
import { readServiceEnv, writeServiceEnv } from "./service.ts";

const PLAN: FixPlan = { allow: [22], newValue: "22", restart: true, restartNote: undefined };
const IDLE: FixPlan = { allow: [], newValue: undefined, restart: false, restartNote: undefined };

it.layer(NodeServices.layer)("t3 sandbox doctor --fix", (it) => {
  const withDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "t3-sandbox-doctor-" });
      return yield* use(dir).pipe(
        Effect.ensuring(fs.remove(dir, { recursive: true }).pipe(Effect.ignore)),
      );
    });

  const run = (dir: string, plan: FixPlan, answer = true) => {
    const restarts: Array<true> = [];
    const asked: Array<string> = [];
    return applyFix(plan, {
      confirm: (message) =>
        Effect.sync(() => {
          asked.push(message);
          return answer;
        }),
      write: (value) => writeServiceEnv(dir, { T3CODE_SANDBOX_HOST_PORTS: value }),
      restart: Effect.sync(() => {
        restarts.push(true);
        return "restarted" as const;
      }),
    }).pipe(Effect.as({ restarts, asked }));
  };

  it.effect("merges the ports into service.env and keeps its other keys, in order", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "service.env");
        yield* fs.writeFileString(
          file,
          "# mine\nT3CODE_LAN=false\nSECRET_KEY=hunter2\nT3CODE_PORT=3773\n",
        );
        const { restarts } = yield* run(dir, PLAN);
        expect(yield* fs.readFileString(file)).toBe(
          "# mine\nT3CODE_LAN=false\nSECRET_KEY=hunter2\nT3CODE_PORT=3773\nT3CODE_SANDBOX_HOST_PORTS=22\n",
        );
        expect(restarts).toHaveLength(1);
      }),
    ),
  );

  it.effect("updates an existing line in place", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "service.env");
        yield* fs.writeFileString(file, "A=1\nT3CODE_SANDBOX_HOST_PORTS=443\nB=2\n");
        yield* run(dir, { ...PLAN, newValue: "443,22" });
        expect(yield* fs.readFileString(file)).toBe("A=1\nT3CODE_SANDBOX_HOST_PORTS=443,22\nB=2\n");
      }),
    ),
  );

  it.effect("does nothing when asked again with nothing left to fix (idempotent)", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        yield* run(dir, PLAN);
        const first = (yield* readServiceEnv(dir)).contents;
        const { restarts, asked } = yield* run(dir, IDLE);
        expect((yield* readServiceEnv(dir)).contents).toBe(first);
        expect(restarts).toHaveLength(0);
        expect(asked).toHaveLength(0);
      }),
    ),
  );

  it.effect("changes nothing when the User declines", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const { restarts } = yield* run(dir, PLAN, false);
        expect((yield* readServiceEnv(dir)).contents).toBe("");
        expect(restarts).toHaveLength(0);
      }),
    ),
  );

  it.effect("prints no values or keys of service.env", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(dir, "service.env"), "SECRET_KEY=hunter2\n");
        yield* run(dir, PLAN);
        const output = (yield* TestConsole.logLines).join("\n");
        expect(output).not.toContain("hunter2");
        expect(output).not.toContain("SECRET_KEY");
      }),
    ),
  );
});

import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { presentConnectionDiagnosis } from "./diagnosis.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const unreachable = () =>
  mapRemoteEnvironmentError(
    new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
  );

const diagnose = (state: SupervisorConnectionState) =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state });

const results = (state: SupervisorConnectionState) =>
  diagnose(state)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("names a host that runs an older T3 Code, without offering to update it", () => {
    const descriptor = (orchestrationProtocolVersion: number): ExecutionEnvironmentDescriptor => ({
      environmentId: EnvironmentId.make("environment-remote"),
      label: "Mac mini",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "9.0.0",
      orchestrationProtocolVersion,
      capabilities: { repositoryIdentity: true },
    });
    const older = orchestrationProtocolCompatibilityError(
      descriptor(ORCHESTRATION_PROTOCOL_VERSION - 1),
    );
    const newer = orchestrationProtocolCompatibilityError(
      descriptor(ORCHESTRATION_PROTOCOL_VERSION + 1),
    );
    if (older === null || newer === null) throw new Error("expected both to be blocked");
    expect(diagnose(backoff(older))?.headline).toBe("Mac mini runs an older T3 Code");
    expect(diagnose(backoff(newer))?.headline).not.toBe("Mac mini runs an older T3 Code");
  });

  it("names T3 Code on the host when it does not answer", () => {
    const state = backoff(unreachable());
    expect(diagnose(state)?.headline).toBe("T3 Code on Mac mini did not answer");
    expect(results(state)).toEqual(["device:ok", "server:failed"]);
  });

  it.each([
    {
      reason: "authentication" as const,
      headline: "T3 Code on Mac mini did not accept this device",
      firstStep: "Sign in to Mac mini again. Its sign-in for this device has ended.",
    },
    {
      reason: "permission" as const,
      headline: "Your account has no access to T3 Code on Mac mini",
      firstStep: "Ask an admin of Mac mini for access, then sign in again.",
    },
  ])("offers to sign in again when the host rejects the $reason", (row) => {
    const diagnosis = diagnose(
      backoff(new ConnectionBlockedError({ reason: row.reason, detail: "", hop: "server" })),
    );
    expect(diagnosis?.headline).toBe(row.headline);
    expect(diagnosis?.steps[0]).toBe(row.firstStep);
    expect(diagnosis?.signInAgain).toBe(true);
    expect(diagnose(backoff(unreachable()))?.signInAgain).toBe(false);
  });

  it("reports this device as offline before any other hop", () => {
    const state = { ...backoff(unreachable()), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("does not report hops as working when the failure names none", () => {
    const failure = new ConnectionBlockedError({
      reason: "authentication",
      detail: "The environment credential is invalid.",
    });
    expect(results(backoff(failure))).not.toContainEqual(expect.stringMatching(/:ok$/));
  });
});

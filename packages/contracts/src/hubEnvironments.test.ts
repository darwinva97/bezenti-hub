import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { HUB_MACHINE_ENVIRONMENT_ID } from "./environmentExecutor.ts";
import { previewThreadPlacement } from "./hubEnvironments.ts";

const laptop = EnvironmentId.make("laptop");
const sandbox = EnvironmentId.make("sandbox:acme");
const claude = ProviderInstanceId.make("claudeAgent");
const provider = {
  instanceId: claude,
  provider: ProviderDriverKind.make("claudeAgent"),
  displayName: null,
  enabled: true,
  installed: true,
  version: null,
  capabilities: {} as never,
};
const preferred = (overrides: object = {}) => ({
  id: laptop,
  kind: "external" as const,
  status: "online" as const,
  providers: [provider],
  usable: true,
  ...overrides,
});

describe("previewThreadPlacement", () => {
  const onHub = (candidate: ReturnType<typeof preferred> | undefined) =>
    previewThreadPlacement({
      preferred: candidate,
      providerInstanceId: claude,
      hubMachine: true,
      spaceSandbox: undefined,
    });
  const inSandbox = (candidate: ReturnType<typeof preferred> | undefined) =>
    previewThreadPlacement({
      preferred: candidate,
      providerInstanceId: claude,
      hubMachine: false,
      spaceSandbox: { id: sandbox },
    });

  it("starts on the preferred Environment only while it can run the Thread", () => {
    expect(onHub(preferred())).toBe(laptop);
    expect(inSandbox(preferred())).toBe(laptop);
    for (const unavailable of [
      preferred({ usable: false }),
      preferred({ status: "offline" }),
      preferred({ status: "reconnecting" }),
      preferred({ providers: [{ ...provider, enabled: false }] }),
      preferred({ providers: [] }),
      undefined,
    ]) {
      expect(onHub(unavailable)).toBe(HUB_MACHINE_ENVIRONMENT_ID);
      expect(inSandbox(unavailable)).toBe(sandbox);
    }
    // Before a provider is chosen, only whether it can run Threads at all.
    const anyProvider = (candidate: ReturnType<typeof preferred>) =>
      previewThreadPlacement({
        preferred: candidate,
        providerInstanceId: null,
        hubMachine: false,
        spaceSandbox: undefined,
      });
    expect(anyProvider(preferred({ providers: [] }))).toBe(laptop);
    expect(anyProvider(preferred({ status: "offline" }))).toBeNull();
    expect(anyProvider(preferred({ usable: false }))).toBeNull();
  });

  it("falls back to the Space's Sandbox, and to nothing on a Hub that runs neither", () => {
    expect(inSandbox(undefined)).toBe(sandbox);
    // Not on the Hub machine unless it runs agents (the development setting).
    expect(
      previewThreadPlacement({
        preferred: undefined,
        providerInstanceId: claude,
        hubMachine: false,
        spaceSandbox: undefined,
      }),
    ).toBeNull();
    expect(
      previewThreadPlacement({
        preferred: preferred({ status: "offline" }),
        providerInstanceId: claude,
        hubMachine: false,
        spaceSandbox: undefined,
      }),
    ).toBeNull();
  });

  it("never places on a Sandbox the Hub cannot run, preferred or not", () => {
    for (const status of ["stopped", "online"] as const) {
      expect(
        previewThreadPlacement({
          preferred: preferred({ kind: "sandbox", status }),
          providerInstanceId: claude,
          hubMachine: false,
          spaceSandbox: { id: sandbox },
          sandboxesRun: false,
        }),
      ).toBeNull();
    }
    expect(
      previewThreadPlacement({
        preferred: preferred(),
        providerInstanceId: claude,
        hubMachine: false,
        spaceSandbox: { id: sandbox },
        sandboxesRun: false,
      }),
    ).toBe(laptop);
  });

  it("counts a Sandbox that is not running as available: the Hub starts it for the work", () => {
    for (const status of ["stopped", "starting"] as const) {
      expect(onHub(preferred({ kind: "sandbox", status, providers: [] }))).toBe(laptop);
    }
    // Not once its start failed, nor stopped without the provider it reported.
    expect(onHub(preferred({ kind: "sandbox", status: "failed", providers: [] }))).toBe(
      HUB_MACHINE_ENVIRONMENT_ID,
    );
    expect(
      onHub(
        preferred({
          kind: "sandbox",
          status: "stopped",
          providers: [{ ...provider, enabled: false }],
        }),
      ),
    ).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(onHub(preferred({ kind: "sandbox", status: "stopped" }))).toBe(laptop);
    // Running, it is held to its providers like any machine; nobody may use it, nothing.
    expect(onHub(preferred({ kind: "sandbox", providers: [] }))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(onHub(preferred({ kind: "sandbox", status: "stopped", usable: false }))).toBe(
      HUB_MACHINE_ENVIRONMENT_ID,
    );
  });
});

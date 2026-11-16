import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { definition, OpenBaoSecretProviderConfig, parseReference } from "./definition.ts";

const isConfig = Schema.is(OpenBaoSecretProviderConfig);
const decode = Schema.decodeUnknownSync(OpenBaoSecretProviderConfig);

const CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const base = {
  address: "https://bao.internal:8200",
  mounts: [
    { path: "kv", version: 2 },
    { path: "team/legacy", version: 1 },
  ],
  authMethod: "kubernetes",
  authRole: "t3-hub",
};

describe("OpenBao definition", () => {
  it("accepts mount/path#field with an optional version", () => {
    for (const reference of [
      "kv/acme/app#token",
      "kv/acme/app?version=3#token",
      "team/legacy/db#password",
      "kv/a.b_c-d/e#f.g",
    ]) {
      expect(definition.isReference(reference), reference).toBe(true);
    }
  });

  it("rejects references without a field, a path, or a positive version, and path tricks", () => {
    for (const reference of [
      "kv/acme/app",
      "kv#token",
      "kv/acme/app#",
      "kv/acme/app?version=0#token",
      "kv/acme/app?version=-1#token",
      "kv/acme/app?v=1#token",
      "kv/acme/app#token?version=1",
      "kv/../app#token",
      "kv/./app#token",
      "kv//app#token",
      "/kv/app#token",
      "kv/a%2fb#token",
      "kv/a b#token",
      "kv/app#tok en",
      "kv/app\n#token",
      `kv/${"x".repeat(1024)}#token`,
    ]) {
      expect(definition.isReference(reference), reference).toBe(false);
    }
  });

  it("reads a reference under its declared mount, by whole segments", () => {
    const config = decode(base);
    expect(parseReference(config.mounts, "kv/acme/app?version=3#token")).toEqual({
      mount: "kv",
      kvVersion: 2,
      path: "acme/app",
      version: 3,
      field: "token",
    });
    expect(parseReference(config.mounts, "team/legacy/db#password")).toEqual({
      mount: "team/legacy",
      kvVersion: 1,
      path: "db",
      version: undefined,
      field: "password",
    });
    expect(parseReference(config.mounts, "kvx/acme#token")).toBeUndefined();
    expect(parseReference(config.mounts, "team/legacyx/db#password")).toBeUndefined();
    expect(parseReference(config.mounts, "kv#token")).toBeUndefined();
  });

  it("says why a reference does not fit the provider's mounts", () => {
    const config = decode(base);
    const problem = definition.configReferenceProblem!;
    expect(problem(config, "kv/acme/app#token")).toBeUndefined();
    expect(problem(config, "other/acme#token")).toMatch(/mount/);
    expect(problem(config, "team/legacy/db?version=2#password")).toMatch(/version/);
  });

  it("takes https anywhere and http only to loopback", () => {
    expect(isConfig({ ...base, address: "http://127.0.0.1:8200" })).toBe(true);
    expect(isConfig({ ...base, address: "http://localhost:8200" })).toBe(true);
    expect(isConfig({ ...base, address: "http://[::1]:8200" })).toBe(true);
    for (const address of [
      "http://bao.internal:8200",
      "ftp://bao.internal",
      "https://user:pass@bao.internal",
      "https://bao.internal/v1",
      "https://bao.internal?x=1",
      "bao.internal:8200",
    ]) {
      expect(isConfig({ ...base, address }), address).toBe(false);
    }
  });

  it("requires each sign-in method's own fields", () => {
    expect(isConfig({ ...base, authRole: undefined })).toBe(false);
    expect(isConfig({ ...base, authMethod: "jwt" })).toBe(false);
    expect(isConfig({ ...base, authMethod: "jwt", tokenFile: "/var/run/secrets/hub/token" })).toBe(
      true,
    );
    expect(isConfig({ ...base, authMethod: "approle", secretId: "" })).toBe(false);
    expect(isConfig({ ...base, authMethod: "approle", roleId: "r-1", secretId: "" })).toBe(true);
    expect(isConfig({ ...base, authMethod: "token", token: "" })).toBe(true);
    expect(isConfig({ ...base, authMethod: "cert", clientKey: "" })).toBe(false);
    expect(isConfig({ ...base, authMethod: "cert", clientCert: CERT, clientKey: "" })).toBe(true);
  });

  it("keeps file paths absolute and private keys out of the certificate fields", () => {
    expect(isConfig({ ...base, tokenFile: "relative/token" })).toBe(false);
    expect(isConfig({ ...base, tokenFile: "/var/run/secrets/a\u0000b" })).toBe(false);
    expect(isConfig({ ...base, caCert: CERT })).toBe(true);
    expect(isConfig({ ...base, caCert: "not a certificate" })).toBe(false);
    expect(
      isConfig({
        ...base,
        caCert: `${CERT}-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n`,
      }),
    ).toBe(false);
  });

  it("needs a declared mount, once each, and has no switch to skip TLS checks", () => {
    expect(isConfig({ ...base, mounts: [] })).toBe(false);
    expect(
      isConfig({
        ...base,
        mounts: [
          { path: "kv", version: 2 },
          { path: "kv", version: 1 },
        ],
      }),
    ).toBe(false);
    expect(isConfig({ ...base, mounts: [{ path: "kv", version: 3 }] })).toBe(false);
    const decoded = decode({ ...base, tlsSkipVerify: true, insecure: true });
    expect(Object.keys(decoded)).not.toContain("tlsSkipVerify");
    expect(Object.keys(decoded)).not.toContain("insecure");
  });

  it("signs in as the Hub with its own identity: a role and an audience, no credential", () => {
    const hub = { ...base, authMethod: "hub_identity", audience: "vault" };
    expect(isConfig(hub)).toBe(true);
    expect(isConfig({ ...hub, audience: undefined })).toBe(false);
    expect(isConfig({ ...hub, authRole: undefined })).toBe(false);
    expect(definition.hubIdentity!(decode(hub))).toEqual({ audience: "vault" });
    expect(definition.hubIdentity!(decode(base))).toBeUndefined();
  });

  it("declares its credentials", () => {
    expect(definition.credentialFields).toEqual(["token", "secretId", "clientKey"]);
  });
});

import { SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  classifySecretProvider,
  draftFromSecretProvider,
  emptyOpenBaoDraft,
  secretProviderFromDraft,
  type OpenBaoDraft,
} from "./SecretProviderDialog.logic";

describe("secretProviderFromDraft", () => {
  it("adds a provider keyed by its name and reports every field that blocks it", () => {
    expect(
      secretProviderFromDraft({ name: "  1Password!  ", account: "my.1password.com" }, new Set(), {
        mode: "add",
      }),
    ).toEqual(
      Result.succeed({
        id: "1password",
        config: {
          kind: "one_password",
          label: "1Password!",
          config: { account: "my.1password.com" },
        },
      }),
    );

    const blocked = secretProviderFromDraft(
      { name: "1Password", account: "--help" },
      new Set(["1password"]),
      { mode: "add" },
    );
    expect(Result.isFailure(blocked) && Object.keys(blocked.failure).toSorted()).toEqual([
      "account",
      "name",
    ]);
  });

  it("keeps the id when an edit renames the provider", () => {
    const id = SecretProviderId.make("personal");
    const result = secretProviderFromDraft(
      { name: "Personal (team)", account: "team.1password.com" },
      new Set(["personal"]),
      { mode: "edit", id },
    );
    expect(Result.isSuccess(result) && result.success).toEqual({
      id,
      config: {
        kind: "one_password",
        label: "Personal (team)",
        config: { account: "team.1password.com" },
      },
    });
  });
});

// Vaults ticket 04: the OpenBao form.
describe("OpenBao drafts", () => {
  const draft = (openBao: Partial<OpenBaoDraft>) => ({
    kind: "openbao" as const,
    name: "Team Bao",
    account: "",
    openBao: { ...emptyOpenBaoDraft, ...openBao },
  });
  const appRole: Partial<OpenBaoDraft> = {
    address: " https://bao.internal:8200 ",
    mounts: "kv v2\n\nteam/legacy v1\n",
    authMethod: "approle",
    roleId: "hub",
    credential: "s-1",
    // Left over from another method: not sent.
    tokenFile: "/var/run/secrets/hub/token",
  };

  it("sends only what the chosen sign-in method uses, mounts parsed", () => {
    expect(secretProviderFromDraft(draft(appRole), new Set(), { mode: "add" })).toEqual(
      Result.succeed({
        id: "team-bao",
        config: {
          kind: "openbao",
          label: "Team Bao",
          config: {
            address: "https://bao.internal:8200",
            mounts: [
              { path: "kv", version: 2 },
              { path: "team/legacy", version: 1 },
            ],
            authMethod: "approle",
            roleId: "hub",
            secretId: "s-1",
          },
        },
      }),
    );
  });

  it("says what blocks a draft: mounts, address, a missing credential", () => {
    const issue = (openBao: Partial<OpenBaoDraft>) => {
      const result = secretProviderFromDraft(draft({ ...appRole, ...openBao }), new Set(), {
        mode: "add",
      });
      return Result.isFailure(result) ? result.failure.openBao : undefined;
    };
    expect(issue({ mounts: "kv v3" })).toMatch(/v1 or v2/);
    expect(issue({ mounts: "" })).toMatch(/mount/);
    expect(issue({ address: "http://bao.internal:8200" })).toMatch(/https/);
    expect(issue({ credential: "" })).toMatch(/secret ID/);
    expect(issue({})).toBeUndefined();
  });

  it("signs in as the Hub with a role and an audience, and no credential (ticket 07)", () => {
    const result = secretProviderFromDraft(
      draft({
        address: "https://bao.internal:8200",
        authMethod: "hub_identity",
        authRole: "t3-acme",
        audience: "vault",
        credential: "left-over",
      }),
      new Set(),
      { mode: "add" },
    );
    expect(Result.isSuccess(result) && result.success.config.config).toEqual({
      address: "https://bao.internal:8200",
      mounts: [{ path: "kv", version: 2 }],
      authMethod: "hub_identity",
      authRole: "t3-acme",
      audience: "vault",
    });
    const missing = secretProviderFromDraft(
      draft({ address: "https://bao.internal:8200", authMethod: "hub_identity", authRole: "r" }),
      new Set(),
      { mode: "add" },
    );
    expect(Result.isFailure(missing) && missing.failure.openBao).toMatch(/audience/);
  });

  it("edits a saved provider without seeing its credential, keeping what the form has no field for", () => {
    const saved = {
      kind: SecretProviderKind.make("openbao"),
      label: "Team Bao",
      config: {
        address: "https://bao.internal:8200",
        mounts: [{ path: "kv", version: 2 }],
        authMethod: "approle",
        roleId: "hub",
        secretId: "__redacted__",
        refreshIntervalSeconds: 60,
      },
    };
    expect(classifySecretProvider(saved).kind).toBe("openbao");
    const edited = draftFromSecretProvider(saved);
    expect(edited.openBao?.mounts).toBe("kv v2");
    const id = SecretProviderId.make("team-bao");
    expect(secretProviderFromDraft(edited, new Set(["team-bao"]), { mode: "edit", id })).toEqual(
      Result.succeed({ id, config: saved }),
    );
  });
});

import type { VaultEntry, VaultSummary, VaultThreadEnvironment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  entryActions,
  entryBadges,
  loadVaultOverview,
  threadSecretLines,
  vaultActions,
  vaultFailureMessage,
  vaultOwnerLine,
} from "./vaults.ts";

const vault = (over: Partial<VaultSummary> = {}) =>
  ({
    id: "vault-a",
    name: "Acme",
    description: null,
    spaceId: "space-acme",
    spaceName: "Acme",
    isMain: false,
    archived: false,
    entryCount: 1,
    canEdit: true,
    canManage: false,
    canReveal: false,
    allowances: [],
    ...over,
  }) as unknown as VaultSummary;
const entry = (over: Partial<VaultEntry> = {}) =>
  ({
    id: "e1",
    vaultId: "vault-a",
    name: "TOKEN",
    description: null,
    kind: "own",
    broken: false,
    linkedFrom: null,
    unmasked: false,
    ...over,
  }) as unknown as VaultEntry;

describe("vaultActions", () => {
  it("lets an editor add and replace only with the write grant", () => {
    expect(vaultActions(vault(), { mayWrite: true, surface: "mobile" })).toMatchObject({
      add: true,
      replace: true,
    });
    expect(vaultActions(vault(), { mayWrite: false, surface: "mobile" })).toMatchObject({
      add: false,
      replace: false,
    });
  });
  it("gives a Member nothing", () => {
    expect(vaultActions(vault({ canEdit: false }), { mayWrite: true, surface: "web" })).toEqual({
      add: false,
      replace: false,
      reveal: false,
    });
  });
  it("never reveals on mobile, even for the Owner", () => {
    const owner = vault({ canReveal: true, canEdit: true, canManage: true });
    expect(vaultActions(owner, { mayWrite: true, surface: "mobile" }).reveal).toBe(false);
    expect(vaultActions(owner, { mayWrite: true, surface: "web" }).reveal).toBe(true);
    expect(vaultActions(owner, { mayWrite: true, surface: "desktop" }).reveal).toBe(true);
  });
});

describe("entryActions", () => {
  it("never replaces a link, and leaves a dangerous name to the Owner", () => {
    const ctx = { mayWrite: true, surface: "mobile" as const, isOwner: false };
    expect(entryActions(vault(), entry({ kind: "link" }), ctx).replace).toBe(false);
    expect(entryActions(vault(), entry({ name: "NODE_OPTIONS" }), ctx).replace).toBe(false);
    expect(
      entryActions(vault(), entry({ name: "NODE_OPTIONS" }), { ...ctx, isOwner: true }).replace,
    ).toBe(false);
    expect(
      entryActions(vault(), entry({ name: "NODE_OPTIONS" }), {
        ...ctx,
        surface: "web",
        isOwner: true,
      }).replace,
    ).toBe(true);
    expect(entryActions(vault(), entry(), ctx).replace).toBe(true);
  });

  it("offers «Reveal» only on a revealable Secret; sealing, reveal and class to editors", () => {
    const owner = vault({ canReveal: true, canEdit: true });
    const web = { mayWrite: true, surface: "web" as const, isOwner: true };
    const revealable = entry({ class: "secret", sealed: false });
    const sealed = entry({ class: "secret", sealed: true });
    const variable = entry({ class: "variable", sealed: false, value: "eu-west-1" });
    expect(entryActions(owner, revealable, web)).toMatchObject({
      reveal: true,
      seal: true,
      allowReveal: false,
      makeVariable: true,
      makeSecret: false,
    });
    expect(entryActions(owner, sealed, web)).toMatchObject({
      reveal: false,
      seal: false,
      allowReveal: true,
      makeVariable: true,
    });
    expect(entryActions(owner, variable, web)).toMatchObject({
      reveal: false,
      seal: false,
      allowReveal: false,
      makeVariable: false,
      makeSecret: true,
    });
    // A link is what its original is; a viewer who does not edit changes nothing.
    expect(
      entryActions(owner, entry({ kind: "link", class: "secret", sealed: false }), web),
    ).toMatchObject({ seal: false, allowReveal: false, makeVariable: false });
    expect(
      entryActions(vault({ canEdit: false }), revealable, { ...web, isOwner: false }),
    ).toMatchObject({ seal: false, allowReveal: false, makeVariable: false, makeSecret: false });
  });
});

describe("labels", () => {
  it("badges links, broken links, copies and unmasked values", () => {
    expect(entryBadges(entry({ kind: "link", broken: true }))).toEqual(["broken"]);
    expect(
      entryBadges(entry({ kind: "link", linkedFrom: { entryId: "m" as never, name: "GH" } })),
    ).toEqual(["linked from Main vault (GH)"]);
    expect(entryBadges(entry({ kind: "link" }))).toEqual(["linked from Main vault"]);
    expect(entryBadges(entry({ kind: "copy", unmasked: true }))).toEqual(["copy", "not masked"]);
  });
  it("describes whose a Vault is", () => {
    expect(vaultOwnerLine(vault())).toBe("Acme's");
    expect(vaultOwnerLine(vault({ spaceId: null, spaceName: null }))).toBe("Yours alone");
  });
});

describe("threadSecretLines", () => {
  it("names the winner and whom it beats, never a value", () => {
    const env = {
      variables: [
        {
          name: "TOKEN",
          vaultName: "Mine",
          source: "user",
          shadowed: [{ vaultId: "v", vaultName: "Acme", source: "space" }],
        },
      ],
    } as unknown as VaultThreadEnvironment;
    expect(threadSecretLines(env)).toEqual([
      { name: "TOKEN", from: "Mine (yours)", winsOver: "Acme (Space default)" },
    ]);
  });
});

describe("loadVaultOverview", () => {
  it("lists the Vaults then each one's names", async () => {
    const a = vault();
    const result = await loadVaultOverview({
      list: async () => ({ vaults: [a] }),
      entries: async (id) => ({ vault: a, entries: id === a.id ? [entry()] : [] }),
    });
    expect(result.vaults).toEqual([a]);
    expect(result.entries["vault-a"]).toHaveLength(1);
  });
});

describe("vaultFailureMessage", () => {
  it("passes a Vault's own message and hides anything else", () => {
    expect(vaultFailureMessage({ _tag: "VaultError", message: "Only the Owner does that." })).toBe(
      "Only the Owner does that.",
    );
    expect(vaultFailureMessage({ _tag: "RpcClientError", message: "body: hunter2" })).toBe(
      "That did not work.",
    );
  });
});

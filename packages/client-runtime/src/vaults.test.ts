import type { VaultEntry, VaultGroupSummary, VaultThreadEnvironment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  entryActions,
  entryBadges,
  loadVaultOverview,
  threadSecretLines,
  vaultActions,
  vaultFailureMessage,
  vaultOwnerLine,
  vaultSections,
} from "./vaults.ts";

const vault = (over: Partial<VaultGroupSummary> = {}) =>
  ({
    id: "vault-a",
    name: "Acme",
    description: null,
    owner: { kind: "organization", spaceId: "space-acme" },
    ownerName: "Acme",
    isDefault: false,
    archived: false,
    entryCount: 1,
    canEdit: true,
    canManage: false,
    allowances: [],
    ...over,
  }) as unknown as VaultGroupSummary;
const entry = (over: Partial<VaultEntry> = {}) =>
  ({
    id: "e1",
    vaultId: "vault-a",
    name: "TOKEN",
    description: null,
    kind: "own",
    delivery: "env",
    broken: false,
    unmasked: false,
    ...over,
  }) as unknown as VaultEntry;

describe("vaultActions", () => {
  it("lets an editor add and replace only with the write grant", () => {
    expect(vaultActions(vault(), { mayWrite: true, surface: "mobile" })).toEqual({
      add: true,
      replace: true,
    });
    expect(vaultActions(vault(), { mayWrite: false, surface: "mobile" })).toEqual({
      add: false,
      replace: false,
    });
  });
  it("gives a Member nothing", () => {
    expect(vaultActions(vault({ canEdit: false }), { mayWrite: true, surface: "web" })).toEqual({
      add: false,
      replace: false,
    });
  });
});

describe("entryActions", () => {
  it("leaves a dangerous name to the Owner", () => {
    const ctx = { mayWrite: true, surface: "mobile" as const, isOwner: false };
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
    // A template is composed from its entries: no value to replace or reclassify.
    const template = entryActions(vault(), entry({ kind: "template", class: "secret" }), {
      ...ctx,
      surface: "web",
      isOwner: true,
    });
    expect(template).toMatchObject({ replace: false, makeVariable: false });
  });

  it("offers no way to read a Secret back, the Owner's included; class changes to editors", () => {
    const owner = vault({ canEdit: true, canManage: true });
    const web = { mayWrite: true, surface: "web" as const, isOwner: true };
    const secret = entry({ class: "secret" });
    const variable = entry({ class: "variable", value: "eu-west-1" });
    const offered = entryActions(owner, secret, web);
    expect(Object.keys(offered).toSorted()).toEqual([
      "add",
      "makeSecret",
      "makeVariable",
      "replace",
    ]);
    expect(offered).toMatchObject({ replace: true, makeVariable: true, makeSecret: false });
    expect(entryActions(owner, variable, web)).toMatchObject({
      makeVariable: false,
      makeSecret: true,
    });
    // A Provider entry is its provider's: nothing to replace or reclassify.
    expect(entryActions(owner, entry({ kind: "provider", class: "secret" }), web)).toMatchObject({
      replace: false,
      makeVariable: false,
    });
    // A viewer who does not edit changes nothing.
    expect(
      entryActions(vault({ canEdit: false }), secret, { ...web, isOwner: false }),
    ).toMatchObject({ makeVariable: false, makeSecret: false });
  });
});

describe("labels", () => {
  it("badges templates, broken ones, files and unmasked values", () => {
    expect(entryBadges(entry({ unmasked: true }))).toEqual(["not masked"]);
    expect(entryBadges(entry({ kind: "template", delivery: "file" }))).toEqual([
      "template",
      "file",
    ]);
    expect(entryBadges(entry({ kind: "template", broken: true }))).toEqual(["broken"]);
    expect(entryBadges(entry({ delivery: "none" }))).toEqual(["not delivered"]);
  });
  it("describes whose Vault a group is part of", () => {
    const me = { userId: "ana" };
    expect(vaultOwnerLine(vault(), me)).toBe("Acme's Vault");
    expect(vaultOwnerLine(vault({ isDefault: true }), me)).toBe(
      "Acme's Vault; every Thread of its Space receives it",
    );
    expect(
      vaultOwnerLine(
        vault({ owner: { kind: "user", userId: "ana" as never }, ownerName: "Ana" }),
        me,
      ),
    ).toBe("Your Vault");
  });
  it("groups by owner, the viewer's own first, with the owners they may add groups to", () => {
    const mine = vault({
      id: "g-mine" as never,
      owner: { kind: "user", userId: "ana" as never },
      ownerName: "Ana",
      isDefault: true,
    });
    const acmeDefault = vault({ id: "g-acme" as never, isDefault: true });
    const acmeNamed = vault({ id: "g-acme-2" as never, name: "Deploy" });
    const sections = vaultSections(
      {
        groups: [mine, acmeDefault, acmeNamed],
        owners: [
          { owner: { kind: "organization", spaceId: "space-acme" as never }, name: "Acme" },
          { owner: { kind: "organization", spaceId: "space-globex" as never }, name: "Globex" },
        ],
      },
      { userId: "ana" },
    );
    expect(
      sections.map((section) => [
        section.name,
        section.mine,
        section.canCreate,
        section.groups.map((group) => group.id),
      ]),
    ).toEqual([
      ["Ana", true, false, ["g-mine"]],
      ["Acme", false, true, ["g-acme", "g-acme-2"]],
      ["Globex", false, true, []],
    ]);
  });
});

describe("threadSecretLines", () => {
  it("names the winner and whom it beats, never a value", () => {
    const env = {
      vaults: [
        { vaultId: "v-mine", name: "Mine", source: "user", ownerName: "Owner" },
        { vaultId: "v", name: "Acme", source: "space", ownerName: null },
      ],
      variables: [
        {
          name: "TOKEN",
          vaultId: "v-mine",
          vaultName: "Mine",
          source: "user",
          shadowed: [{ vaultId: "v", vaultName: "Acme", source: "space" }],
        },
      ],
    } as unknown as VaultThreadEnvironment;
    expect(threadSecretLines(env)).toEqual([
      {
        name: "TOKEN",
        from: "Mine · Owner (yours)",
        winsOver: "Acme (Space default)",
        value: null,
        withheld: null,
      },
    ]);
  });

  it("lists a lent group's names never delivered, after the rest, and why (Grants 07)", () => {
    const env = {
      vaults: [{ vaultId: "v-ana", name: "Ana keys", source: "space", ownerName: "Ana" }],
      variables: [
        {
          name: "ANA_TOKEN",
          vaultId: "v-ana",
          vaultName: "Ana keys",
          source: "space",
          shadowed: [],
        },
      ],
      withheld: [
        { name: "NODE_OPTIONS", vaultId: "v-ana", vaultName: "Ana keys", reason: "lent-dangerous" },
      ],
    } as unknown as VaultThreadEnvironment;
    expect(threadSecretLines(env).map((line) => [line.name, line.from, line.withheld])).toEqual([
      ["ANA_TOKEN", "Ana keys · Ana (Space default)", null],
      ["NODE_OPTIONS", "Ana keys · Ana", "not delivered: from a loan"],
    ]);
  });
});

describe("Variables in a Thread's panel (owned-resources 05)", () => {
  it("shows a Variable's value and never a Secret's, even if one came along", () => {
    const env = {
      variables: [
        {
          name: "REGION",
          vaultId: "v",
          vaultName: "Acme",
          source: "space",
          class: "variable",
          value: "eu-west-1",
          shadowed: [],
        },
        {
          name: "API_KEY",
          vaultId: "v",
          vaultName: "Acme",
          source: "space",
          class: "secret",
          value: "leaked-by-mistake",
          shadowed: [],
        },
      ],
    } as unknown as VaultThreadEnvironment;
    expect(threadSecretLines(env).map((line) => [line.name, line.value])).toEqual([
      ["REGION", "eu-west-1"],
      ["API_KEY", null],
    ]);
  });
});

describe("loadVaultOverview", () => {
  it("lists the Vaults then each one's names", async () => {
    const a = vault();
    const result = await loadVaultOverview({
      list: async () => ({ groups: [a], owners: [], unlinked: [] }),
      entries: async (id) => ({ group: a, entries: id === a.id ? [entry()] : [] }),
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

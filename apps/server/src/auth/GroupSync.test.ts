/**
 * `planGroupSync` (Keycloak sign-in spec, «Grupos → memberships», seam 2): one row per case of the
 * spec's rule. A new case is a new row.
 */
import { SpaceId, type SpaceRole } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  type CurrentMembership,
  type GroupChange,
  type GroupMapping,
  grantsAdmin,
  groupsOf,
  MAX_TOKEN_GROUPS,
  normalizeGroup,
  planGroupSync,
} from "./GroupSync.ts";

const bezenti = SpaceId.make("org-bezenti");
const acme = SpaceId.make("org-acme");

const mapping = (
  group: string,
  spaceId: SpaceId,
  role: SpaceRole,
  options: { readonly enabled?: boolean; readonly archived?: boolean } = {},
): GroupMapping => ({
  group,
  spaceId,
  role,
  enabled: options.enabled ?? true,
  archived: options.archived ?? false,
});

const manual = (spaceId: SpaceId, role: SpaceRole, archived = false): CurrentMembership => ({
  spaceId,
  role,
  managed: false,
  group: null,
  archived,
});
const managed = (
  spaceId: SpaceId,
  role: SpaceRole,
  group: string,
  archived = false,
): CurrentMembership => ({ spaceId, role, managed: true, group, archived });

const bezentiMappings = [
  mapping("bezenti", bezenti, "member"),
  mapping("bezenti-admin", bezenti, "admin"),
];

interface Row {
  readonly name: string;
  readonly memberships: ReadonlyArray<CurrentMembership>;
  readonly groups: ReadonlyArray<string>;
  readonly mappings: ReadonlyArray<GroupMapping>;
  readonly changes: ReadonlyArray<GroupChange>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    name: "a mapped group adds a managed Membership",
    memberships: [],
    groups: ["bezenti"],
    mappings: bezentiMappings,
    changes: [{ kind: "add", spaceId: bezenti, role: "member", group: "bezenti" }],
  },
  {
    name: "a full path with a leading / matches a mapping without one",
    memberships: [],
    groups: ["/bezenti"],
    mappings: bezentiMappings,
    changes: [{ kind: "add", spaceId: bezenti, role: "member", group: "bezenti" }],
  },
  {
    name: "a mapping saved with a leading / matches a group without one",
    memberships: [],
    groups: ["bezenti"],
    mappings: [mapping("/bezenti", bezenti, "guest")],
    changes: [{ kind: "add", spaceId: bezenti, role: "guest", group: "bezenti" }],
  },
  {
    name: "a subgroup's full path matches only its full path",
    memberships: [],
    groups: ["/acme/dev"],
    mappings: [mapping("dev", acme, "member"), mapping("acme/dev", acme, "guest")],
    changes: [{ kind: "add", spaceId: acme, role: "guest", group: "acme/dev" }],
  },
  {
    name: "several groups for one Organization: the highest Role wins",
    memberships: [],
    groups: ["bezenti", "bezenti-admin"],
    mappings: bezentiMappings,
    changes: [{ kind: "add", spaceId: bezenti, role: "admin", group: "bezenti-admin" }],
  },
  {
    name: "two groups with the same Role: the first by name labels it",
    memberships: [],
    groups: ["zeta", "alpha"],
    mappings: [mapping("zeta", acme, "member"), mapping("alpha", acme, "member")],
    changes: [{ kind: "add", spaceId: acme, role: "member", group: "alpha" }],
  },
  {
    name: "a managed Membership follows its groups' Role",
    memberships: [managed(bezenti, "member", "bezenti")],
    groups: ["bezenti", "bezenti-admin"],
    mappings: bezentiMappings,
    changes: [
      {
        kind: "changeRole",
        spaceId: bezenti,
        from: "member",
        to: "admin",
        group: "bezenti-admin",
      },
    ],
  },
  {
    name: "leaving the admin group demotes a managed Admin",
    memberships: [managed(bezenti, "admin", "bezenti-admin")],
    groups: ["bezenti"],
    mappings: bezentiMappings,
    changes: [
      { kind: "changeRole", spaceId: bezenti, from: "admin", to: "member", group: "bezenti" },
    ],
  },
  {
    name: "leaving every mapped group removes the managed Membership",
    memberships: [managed(bezenti, "member", "bezenti")],
    groups: ["other"],
    mappings: bezentiMappings,
    changes: [{ kind: "remove", spaceId: bezenti, role: "member", group: "bezenti" }],
  },
  {
    name: "an absent claim is an empty list: managed goes, manual stays",
    memberships: [managed(bezenti, "member", "bezenti"), manual(acme, "admin")],
    groups: groupsOf({ sub: "someone" }, "groups"),
    mappings: [...bezentiMappings, mapping("acme", acme, "member")],
    changes: [{ kind: "remove", spaceId: bezenti, role: "member", group: "bezenti" }],
  },
  {
    name: "a manual Membership without a mapped group of theirs is left alone",
    memberships: [manual(bezenti, "guest")],
    groups: [],
    mappings: bezentiMappings,
    changes: [],
  },
  {
    name: "a manual Membership where their group maps becomes managed",
    memberships: [manual(bezenti, "member")],
    groups: ["bezenti-admin"],
    mappings: bezentiMappings,
    changes: [
      { kind: "manage", spaceId: bezenti, from: "member", to: "admin", group: "bezenti-admin" },
    ],
  },
  {
    name: "a manual Membership with the group's Role still becomes managed",
    memberships: [manual(bezenti, "member")],
    groups: ["bezenti"],
    mappings: bezentiMappings,
    changes: [{ kind: "manage", spaceId: bezenti, from: "member", to: "member", group: "bezenti" }],
  },
  {
    name: "an archived Organization is not touched, either way",
    memberships: [managed(bezenti, "member", "bezenti", true)],
    groups: ["acme"],
    mappings: [
      mapping("bezenti", bezenti, "member", { archived: true }),
      mapping("acme", acme, "member", { archived: true }),
    ],
    changes: [],
  },
  {
    name: "an archived Organization without mappings keeps its managed Membership",
    memberships: [managed(bezenti, "member", "bezenti", true)],
    groups: [],
    mappings: [],
    changes: [],
  },
  {
    name: "an Organization whose mapping is gone releases its managed Membership",
    memberships: [managed(bezenti, "admin", "bezenti-admin")],
    groups: ["bezenti-admin"],
    mappings: [],
    changes: [{ kind: "release", spaceId: bezenti, role: "admin", group: "bezenti-admin" }],
  },
  {
    name: "a disabled mapping applies nothing and releases what it managed",
    memberships: [managed(bezenti, "member", "bezenti")],
    groups: ["bezenti", "acme"],
    mappings: [
      mapping("bezenti", bezenti, "member", { enabled: false }),
      mapping("acme", acme, "admin", { enabled: false }),
    ],
    changes: [{ kind: "release", spaceId: bezenti, role: "member", group: "bezenti" }],
  },
  {
    name: "same Role from another group: only the label changes",
    memberships: [managed(acme, "member", "zeta")],
    groups: ["alpha", "zeta"],
    mappings: [mapping("zeta", acme, "member"), mapping("alpha", acme, "member")],
    changes: [{ kind: "relabel", spaceId: acme, role: "member", group: "alpha" }],
  },
  {
    name: "nothing to do when the Hub already says what Keycloak says",
    memberships: [managed(bezenti, "admin", "bezenti-admin"), manual(acme, "guest")],
    groups: ["bezenti", "bezenti-admin"],
    mappings: bezentiMappings,
    changes: [],
  },
  {
    name: "each Organization is planned on its own",
    memberships: [managed(acme, "member", "acme"), manual(bezenti, "guest")],
    groups: ["bezenti"],
    mappings: [...bezentiMappings, mapping("acme", acme, "member")],
    changes: [
      { kind: "remove", spaceId: acme, role: "member", group: "acme" },
      { kind: "manage", spaceId: bezenti, from: "guest", to: "member", group: "bezenti" },
    ],
  },
];

describe("planGroupSync", () => {
  it.each(ROWS)("$name", (row) => {
    assert.deepStrictEqual(
      planGroupSync({ memberships: row.memberships, groups: row.groups, mappings: row.mappings }),
      row.changes,
    );
  });

  it("grants Admin only when a change makes them one", () => {
    const promote = planGroupSync({
      memberships: [managed(bezenti, "member", "bezenti")],
      groups: ["bezenti-admin"],
      mappings: bezentiMappings,
    });
    assert.isTrue(grantsAdmin(promote));
    const stay = planGroupSync({
      memberships: [managed(bezenti, "admin", "bezenti-admin")],
      groups: ["bezenti-admin"],
      mappings: bezentiMappings,
    });
    assert.isFalse(grantsAdmin(stay));
    const takeOver = planGroupSync({
      memberships: [manual(bezenti, "admin")],
      groups: ["bezenti-admin"],
      mappings: bezentiMappings,
    });
    assert.isFalse(grantsAdmin(takeOver));
  });
});

describe("groupsOf", () => {
  it("reads the named claim as a list of strings, without a leading /", () => {
    assert.deepStrictEqual(groupsOf({ teams: ["/a", "b", "/a"] }, "teams"), ["a", "b"]);
  });

  it("is empty for an absent claim or one of another shape", () => {
    assert.deepStrictEqual(groupsOf({}, "groups"), []);
    assert.deepStrictEqual(groupsOf({ groups: "bezenti" }, "groups"), []);
    assert.deepStrictEqual(groupsOf({ groups: { bezenti: true } }, "groups"), []);
  });

  it("skips entries that are not usable group names", () => {
    assert.deepStrictEqual(
      groupsOf({ groups: [1, null, "", "/", "x".repeat(300), "ok"] }, "groups"),
      ["ok"],
    );
  });

  it("reads at most MAX_TOKEN_GROUPS groups", () => {
    const many = Array.from({ length: MAX_TOKEN_GROUPS + 10 }, (_, index) => `g${index}`);
    assert.strictEqual(groupsOf({ groups: many }, "groups").length, MAX_TOKEN_GROUPS);
  });

  it("never reads an inherited property as the claim", () => {
    assert.deepStrictEqual(groupsOf({}, "constructor"), []);
  });

  it("normalizes one leading / only", () => {
    assert.strictEqual(normalizeGroup("//x"), "/x");
  });
});

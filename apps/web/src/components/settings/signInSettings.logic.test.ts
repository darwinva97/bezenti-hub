import { type SignInSettings, SpaceId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import {
  changesOf,
  clientUrlsOf,
  formOf,
  keycloakWarningsOf,
  valuesOf,
  withMapping,
} from "./signInSettings.logic";

const saved: SignInSettings = {
  registrationMode: "invitation-only",
  localSignInForMembers: true,
  keycloak: {
    enabled: false,
    issuer: "https://auth.example.com/realms/acme",
    clientId: "t3-hub",
    clientSecretSet: true,
    clientSecretUpdatedAt: "2026-11-18T10:00:00.000Z",
    groupsClaim: "groups",
    strongAcr: [],
    strongAmr: [],
  },
  groupMappings: [],
  mappableOrganizations: [{ spaceId: SpaceId.make("org-acme"), name: "Acme" }],
  publicOrigin: null,
  updatedAt: "2026-11-18T10:00:00.000Z",
};

describe("sign-in settings form", () => {
  it("sends only what changed, and the secret only when typed", () => {
    expect(changesOf(saved, formOf(saved))).toBeNull();
    const changed = changesOf(saved, {
      ...formOf(saved),
      registrationMode: "closed",
      clientSecret: "new-secret",
    });
    expect(changed?.registrationMode).toBe("closed");
    expect(changed?.issuer).toBeUndefined();
    expect(Redacted.value(changed!.clientSecret!)).toBe("new-secret");
  });
});

describe("the strong-factor lists", () => {
  it("are typed with commas or blanks, and sent only when they change", () => {
    expect(valuesOf(" critica, basico  critica,,")).toEqual(["critica", "basico"]);
    expect(valuesOf("  ")).toEqual([]);
    expect(changesOf(saved, { ...formOf(saved), strongAcr: " " })).toBeNull();
    const changed = changesOf(saved, { ...formOf(saved), strongAcr: "critica", strongAmr: "otp" });
    expect(changed?.strongAcr).toEqual(["critica"]);
    expect(changed?.strongAmr).toEqual(["otp"]);
    const listed = { ...saved, keycloak: { ...saved.keycloak, strongAcr: ["critica"] } };
    expect(changesOf(listed, formOf(listed))).toBeNull();
    expect(changesOf(listed, { ...formOf(listed), strongAcr: "" })?.strongAcr).toEqual([]);
  });
});

describe("Keycloak's warnings for the Owner (ticket 07)", () => {
  const date = (iso: string) => `on ${iso.slice(0, 10)}`;
  const healthy = { unreachableSince: null, problem: null, lastLoginOffline: true } as const;

  it("tell a realm that does not answer from one that rejects the Hub's client", () => {
    expect(keycloakWarningsOf(true, healthy, date)).toEqual([]);
    const down = keycloakWarningsOf(
      true,
      { ...healthy, unreachableSince: "2026-11-20T10:00:00.000Z", problem: "unreachable" },
      date,
    );
    expect(down).toHaveLength(1);
    expect(down[0]).toMatch(/has not answered since on 2026-11-20/);
    const rejected = keycloakWarningsOf(
      true,
      { ...healthy, unreachableSince: "2026-11-20T10:00:00.000Z", problem: "rejected" },
      date,
    );
    expect(rejected[0]).toMatch(/rejected this Hub's client .*client secret/);
  });

  it("say when the newest sign-in got no offline_access, and nothing while Keycloak is off", () => {
    const offline = { ...healthy, lastLoginOffline: false };
    expect(keycloakWarningsOf(true, offline, date)[0]).toMatch(/offline_access/);
    expect(keycloakWarningsOf(false, offline, date)).toEqual([]);
    expect(keycloakWarningsOf(true, undefined, date)).toEqual([]);
    expect(keycloakWarningsOf(true, { ...healthy, lastLoginOffline: null }, date)).toEqual([]);
  });
});

describe("the URLs for the Keycloak client", () => {
  it("follow T3CODE_PUBLIC_URL, else the page's address, and say which", () => {
    const published = clientUrlsOf("https://hub.example.com", "http://localhost:5733");
    expect(published.fromPage).toBe(false);
    expect(published.urls.map((entry) => entry.url)).toEqual([
      "https://hub.example.com/oauth/keycloak/callback",
      "https://hub.example.com/oauth/keycloak/backchannel-logout",
      "https://hub.example.com/sign-in",
    ]);
    const local = clientUrlsOf(null, "http://localhost:5733");
    expect(local.fromPage).toBe(true);
    expect(local.urls[0]?.url).toBe("http://localhost:5733/oauth/keycloak/callback");
  });
});

describe("the Keycloak group mappings (ticket 05)", () => {
  const acme = SpaceId.make("org-acme");

  it("adds a mapping into an Organization the Owner may map into, once", () => {
    const added = withMapping(saved, [], { group: " /bezenti ", spaceId: acme, role: "member" });
    expect("rows" in added && added.rows).toEqual([
      {
        group: "bezenti",
        spaceId: acme,
        organizationName: "Acme",
        role: "member",
        enabled: true,
        archived: false,
      },
    ]);
    const rows = "rows" in added ? added.rows : [];
    expect(withMapping(saved, rows, { group: "bezenti", spaceId: acme, role: "admin" })).toEqual({
      error: "bezenti is already mapped to Acme.",
    });
    expect(withMapping(saved, rows, { group: " ", spaceId: acme, role: "admin" })).toEqual({
      error: "Enter the Keycloak group.",
    });
    expect(
      withMapping(saved, rows, {
        group: "x",
        spaceId: SpaceId.make("org-someone-elses"),
        role: "admin",
      }),
    ).toEqual({ error: "Choose the Organization." });
  });

  it("sends the whole list only when it changed, and the claim only when it did", () => {
    const added = withMapping(saved, [], { group: "bezenti", spaceId: acme, role: "member" });
    const rows = "rows" in added ? added.rows : [];
    expect(changesOf(saved, { ...formOf(saved), groupMappings: rows })?.groupMappings).toEqual([
      { group: "bezenti", spaceId: acme, role: "member" },
    ]);
    const mapped = { ...saved, groupMappings: rows };
    expect(changesOf(mapped, formOf(mapped))).toBeNull();
    expect(changesOf(mapped, { ...formOf(mapped), groupMappings: [] })?.groupMappings).toEqual([]);
    expect(changesOf(saved, { ...formOf(saved), groupsClaim: " groups " })).toBeNull();
    expect(changesOf(saved, { ...formOf(saved), groupsClaim: "teams" })?.groupsClaim).toBe("teams");
  });
});

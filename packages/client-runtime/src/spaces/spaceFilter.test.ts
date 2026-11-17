import type { SpaceDirectoryView, SpaceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterProjectsBySpace,
  filterThreadsBySpace,
  hiddenProjectKeys,
  inSpaceProjectKeys,
  legacySpaceIdOf,
  spaceToFollow,
  threadSpaceId,
} from "./spaceFilter.ts";

const personal = "space-personal" as SpaceId;
const acme = "space-acme" as SpaceId;
const env = "env-1";

const project = (id: string, spaceId?: SpaceId | null, environmentId = env) => ({
  environmentId,
  id,
  spaceId,
});
const thread = (id: string, projectId: string, spaceId?: SpaceId | null, environmentId = env) => ({
  environmentId,
  id,
  projectId,
  spaceId,
});

const ids = (items: ReadonlyArray<{ readonly id: string }>) => items.map((item) => item.id);

describe("threadSpaceId", () => {
  it("prefers the Thread's own Space over its Project's", () => {
    expect(threadSpaceId(thread("t", "p", acme), project("p", personal))).toBe(acme);
  });

  it("falls back to the Project's Space", () => {
    expect(threadSpaceId(thread("t", "p"), project("p", acme))).toBe(acme);
    expect(threadSpaceId(thread("t", "p", null), project("p", acme))).toBe(acme);
  });

  it("is the given legacy Space, else null, when neither is known", () => {
    expect(threadSpaceId(thread("t", "p"), project("p"))).toBeNull();
    expect(threadSpaceId(thread("t", "p"), undefined)).toBeNull();
    expect(threadSpaceId(thread("t", "p"), project("p"), personal)).toBe(personal);
  });
});

describe("legacySpaceIdOf", () => {
  const view = (isOwner: boolean) =>
    ({ isOwner, personalSpaceId: personal }) as Pick<
      SpaceDirectoryView,
      "isOwner" | "personalSpaceId"
    >;

  it("puts rows from before Spaces in the Owner's Personal space, as the server does", () => {
    expect(legacySpaceIdOf(view(true))).toBe(personal);
  });

  it("is none for anyone else, who is never sent such rows", () => {
    expect(legacySpaceIdOf(view(false))).toBeNull();
    expect(legacySpaceIdOf(null)).toBeNull();
  });
});

describe("space filtering", () => {
  const projects = [project("p-acme", acme), project("p-personal", personal)];
  const threads = [
    thread("t-acme", "p-acme"),
    thread("t-personal", "p-personal"),
    thread("t-own", "p-personal", acme),
  ];
  const threadsIn = (
    spaceId: SpaceId | null,
    list = threads,
    legacySpaceId: SpaceId | null = null,
  ) =>
    filterThreadsBySpace({ spaceId, environmentId: env, threads: list, projects, legacySpaceId });
  const projectsIn = (
    spaceId: SpaceId | null,
    list = projects,
    legacySpaceId: SpaceId | null = null,
  ) => filterProjectsBySpace({ spaceId, environmentId: env, projects: list, legacySpaceId });

  it("keeps the Threads of the Space, by own Space first and else the Project's", () => {
    expect(ids(threadsIn(acme))).toEqual(["t-acme", "t-own"]);
    expect(ids(threadsIn(personal))).toEqual(["t-personal"]);
  });

  it("keeps only the Projects of the Space", () => {
    expect(ids(projectsIn(personal))).toEqual(["p-personal"]);
    expect(ids(projectsIn(acme))).toEqual(["p-acme"]);
  });

  it("never mixes Spaces: an open Thread of another Space is not listed", () => {
    const chain = [thread("a", "p-acme"), thread("b", "p-acme"), ...threads];
    expect(ids(threadsIn(personal, chain))).toEqual(["t-personal"]);
  });

  it("lists rows from before Spaces only in the legacy Space, the Owner's Personal space", () => {
    const loose = [project("p-old"), project("p-null", null)];
    expect(ids(projectsIn(acme, loose, personal))).toEqual([]);
    expect(ids(projectsIn(personal, loose, personal))).toEqual(["p-old", "p-null"]);
    const looseThreads = [thread("t-old", "p-old"), thread("t-missing", "p-gone")];
    expect(ids(threadsIn(acme, looseThreads, personal))).toEqual([]);
    expect(ids(threadsIn(personal, looseThreads, personal))).toEqual(["t-old", "t-missing"]);
    // Without a legacy Space (not the Owner), they are listed nowhere.
    expect(ids(projectsIn(personal, loose))).toEqual([]);
  });

  it("returns the same arrays when there is nothing to filter by or to drop", () => {
    expect(threadsIn(null)).toBe(threads);
    expect(projectsIn(null)).toBe(projects);
    const own = [project("p", acme)];
    expect(projectsIn(acme, own)).toBe(own);
    const mine = [thread("t", "p", acme)];
    expect(threadsIn(acme, mine)).toBe(mine);
  });

  it("keeps a Thread of the Space whose Project entity is missing", () => {
    const lost = [thread("t-lost", "p-gone", acme)];
    expect(ids(threadsIn(acme, lost))).toEqual(["t-lost"]);
    expect(ids(threadsIn(personal, lost))).toEqual([]);
  });

  it("leaves other environments alone, whose Spaces are not this filter's", () => {
    const foreign = [thread("t", "p", personal, "env-2")];
    expect(ids(threadsIn(acme, foreign))).toEqual(["t"]);
    expect(ids(projectsIn(acme, [project("p", personal, "env-2")]))).toEqual(["p"]);
  });

  it("keeps the filtered Projects array across calls with the same inputs", () => {
    expect(projectsIn(personal)).toBe(projectsIn(personal));
  });

  it("lists the keys of the Projects in the Space", () => {
    const keys = inSpaceProjectKeys({
      spaceId: personal,
      environmentId: env,
      projects,
      legacySpaceId: null,
    });
    expect([...(keys ?? [])]).toEqual([`${env}:p-personal`]);
    expect(
      inSpaceProjectKeys({ spaceId: null, environmentId: env, projects, legacySpaceId: null }),
    ).toBeNull();
    expect(
      inSpaceProjectKeys({ spaceId: personal, environmentId: env, projects, legacySpaceId: null }),
    ).toBe(keys);
  });

  it("names the Projects the filter hides", () => {
    const kept = projectsIn(personal);
    expect([...(hiddenProjectKeys(projects, kept) ?? [])]).toEqual([`${env}:p-acme`]);
    expect(hiddenProjectKeys(projects, projects)).toBeNull();
  });
});

describe("spaceToFollow", () => {
  const view = { spaces: [{ id: personal }, { id: acme }] };

  it("switches to the Space of what was opened when the User has it", () => {
    expect(spaceToFollow({ view, currentSpaceId: personal, openSpaceId: acme })).toBe(acme);
  });

  it("stays put when it is already current, unknown, or not one of the User's Spaces", () => {
    expect(spaceToFollow({ view, currentSpaceId: acme, openSpaceId: acme })).toBeNull();
    expect(spaceToFollow({ view, currentSpaceId: acme, openSpaceId: null })).toBeNull();
    expect(
      spaceToFollow({ view, currentSpaceId: acme, openSpaceId: "space-other" as SpaceId }),
    ).toBeNull();
    expect(spaceToFollow({ view: null, currentSpaceId: null, openSpaceId: acme })).toBeNull();
  });
});

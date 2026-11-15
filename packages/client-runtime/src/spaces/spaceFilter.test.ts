import type { SpaceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveSpaceFilter,
  filterProjectsBySpace,
  filterThreadsBySpace,
  hiddenProjectKeys,
  inSpaceProjectKeys,
  showAllSpacesStorageKey,
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

  it("is null when neither is known", () => {
    expect(threadSpaceId(thread("t", "p"), project("p"))).toBeNull();
    expect(threadSpaceId(thread("t", "p"), undefined)).toBeNull();
  });
});

describe("effectiveSpaceFilter", () => {
  it("filters by the current Space", () => {
    expect(effectiveSpaceFilter({ currentSpaceId: acme, showAllSpaces: false })).toBe(acme);
  });

  it("does not filter without a current Space", () => {
    expect(effectiveSpaceFilter({ currentSpaceId: null, showAllSpaces: false })).toBeNull();
  });

  it("does not filter when All Spaces is on", () => {
    expect(effectiveSpaceFilter({ currentSpaceId: acme, showAllSpaces: true })).toBeNull();
  });
});

describe("showAllSpacesStorageKey", () => {
  it("is per User", () => {
    expect(showAllSpacesStorageKey("u1" as never)).not.toBe(showAllSpacesStorageKey("u2" as never));
  });
});

describe("space filtering", () => {
  const projects = [project("p-acme", acme), project("p-personal", personal)];
  const threads = [
    thread("t-acme", "p-acme"),
    thread("t-personal", "p-personal"),
    thread("t-own", "p-personal", acme),
  ];
  type Open = Array<{ environmentId: string; threadId: string }>;
  const threadsIn = (spaceId: SpaceId | null, openThreads: Open = [], list = threads) =>
    filterThreadsBySpace({ spaceId, environmentId: env, threads: list, projects, openThreads });
  const projectsIn = (spaceId: SpaceId | null, keepProjectKeys: string[] = [], list = projects) =>
    filterProjectsBySpace({ spaceId, environmentId: env, projects: list, keepProjectKeys });

  it("keeps the Threads of the Space, by own Space first and else the Project's", () => {
    expect(ids(threadsIn(acme))).toEqual(["t-acme", "t-own"]);
    expect(ids(threadsIn(personal))).toEqual(["t-personal"]);
  });

  it("keeps the Projects of the Space, and those asked to stay", () => {
    expect(ids(projectsIn(personal))).toEqual(["p-personal"]);
    expect(ids(projectsIn(personal, [`${env}:p-acme`]))).toEqual(["p-acme", "p-personal"]);
  });

  it("shows items whose Space is unknown", () => {
    const loose = [project("p-old"), project("p-null", null)];
    expect(ids(projectsIn(acme, [], loose))).toEqual(["p-old", "p-null"]);
    const looseThreads = [thread("t-old", "p-old"), thread("t-missing", "p-gone")];
    expect(ids(threadsIn(acme, [], looseThreads))).toEqual(["t-old", "t-missing"]);
  });

  it("returns the same arrays when there is nothing to filter by or to drop", () => {
    expect(threadsIn(null)).toBe(threads);
    expect(projectsIn(null)).toBe(projects);
    const own = [project("p", acme)];
    expect(projectsIn(acme, [], own)).toBe(own);
    const mine = [thread("t", "p")];
    expect(threadsIn(acme, [], mine)).toBe(mine);
  });

  it("keeps the open Thread and a whole chain of open ancestors from another Space", () => {
    const chain = [thread("a", "p-acme"), thread("b", "p-acme"), thread("c", "p-acme"), ...threads];
    const open = ["a", "b", "c"].map((threadId) => ({ environmentId: env, threadId }));
    expect(ids(threadsIn(personal, open, chain))).toEqual(["a", "b", "c", "t-personal"]);
  });

  it("keeps a Thread whose Project entity is missing", () => {
    const lost = [thread("t-lost", "p-gone", acme)];
    expect(ids(threadsIn(personal, [{ environmentId: env, threadId: "t-lost" }], lost))).toEqual([
      "t-lost",
    ]);
  });

  it("leaves other environments alone, whose Spaces are not this filter's", () => {
    const foreign = [thread("t", "p", personal, "env-2")];
    expect(ids(threadsIn(acme, [], foreign))).toEqual(["t"]);
    expect(ids(projectsIn(acme, [], [project("p", personal, "env-2")]))).toEqual(["p"]);
  });

  it("keeps the filtered Projects array across calls with the same inputs", () => {
    expect(projectsIn(personal, [`${env}:p-acme`])).toBe(projectsIn(personal, [`${env}:p-acme`]));
    expect(projectsIn(personal)).toBe(projectsIn(personal));
  });

  it("lists the Projects in the Space apart from those merely kept", () => {
    const keys = inSpaceProjectKeys({ spaceId: personal, environmentId: env, projects });
    expect([...(keys ?? [])]).toEqual([`${env}:p-personal`]);
    expect(inSpaceProjectKeys({ spaceId: null, environmentId: env, projects })).toBeNull();
    expect(inSpaceProjectKeys({ spaceId: personal, environmentId: env, projects })).toBe(keys);
  });

  it("names the Projects the filter hides", () => {
    const kept = projectsIn(personal);
    expect([...(hiddenProjectKeys(projects, kept) ?? [])]).toEqual([`${env}:p-acme`]);
    expect(hiddenProjectKeys(projects, projects)).toBeNull();
  });
});

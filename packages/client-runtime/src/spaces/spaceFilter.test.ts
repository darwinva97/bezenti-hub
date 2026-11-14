import type { SpaceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveSpaceFilter,
  filterBySpace,
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

describe("filterBySpace", () => {
  const projects = [project("p-acme", acme), project("p-personal", personal)];
  const threads = [
    thread("t-acme", "p-acme"),
    thread("t-personal", "p-personal"),
    thread("t-own", "p-personal", acme),
  ];

  it("keeps only the Threads and Projects of the Space", () => {
    const result = filterBySpace({
      spaceId: acme,
      environmentId: env,
      projects,
      threads,
      openThreads: [],
      openProject: null,
    });
    expect(ids(result.threads)).toEqual(["t-acme", "t-own"]);
    // The Personal Project stays because it hosts a Thread of Acme.
    expect(ids(result.projects)).toEqual(["p-acme", "p-personal"]);
  });

  it("drops a Project with nothing of the Space", () => {
    const result = filterBySpace({
      spaceId: personal,
      environmentId: env,
      projects,
      threads: [thread("t-acme", "p-acme"), thread("t-personal", "p-personal")],
      openThreads: [],
      openProject: null,
    });
    expect(ids(result.threads)).toEqual(["t-personal"]);
    expect(ids(result.projects)).toEqual(["p-personal"]);
  });

  it("shows items whose Space is unknown", () => {
    const result = filterBySpace({
      spaceId: acme,
      environmentId: env,
      projects: [project("p-old"), project("p-null", null)],
      threads: [thread("t-old", "p-old"), thread("t-missing", "p-gone")],
      openThreads: [],
      openProject: null,
    });
    expect(ids(result.threads)).toEqual(["t-old", "t-missing"]);
    expect(ids(result.projects)).toEqual(["p-old", "p-null"]);
  });

  it("returns the same arrays when there is nothing to filter by", () => {
    const result = filterBySpace({
      spaceId: null,
      environmentId: env,
      projects,
      threads,
      openThreads: [],
      openProject: null,
    });
    expect(result.threads).toBe(threads);
    expect(result.projects).toBe(projects);
  });

  it("returns the same arrays when everything is kept", () => {
    const own = [project("p", acme)];
    const mine = [thread("t", "p")];
    const result = filterBySpace({
      spaceId: acme,
      environmentId: env,
      projects: own,
      threads: mine,
      openThreads: [],
      openProject: null,
    });
    expect(result.threads).toBe(mine);
    expect(result.projects).toBe(own);
  });

  it("keeps the open Thread and its Project even from another Space", () => {
    const result = filterBySpace({
      spaceId: personal,
      environmentId: env,
      projects,
      threads: [thread("t-acme", "p-acme"), thread("t-other", "p-acme")],
      openThreads: [{ environmentId: env, threadId: "t-acme" }],
      openProject: null,
    });
    expect(ids(result.threads)).toEqual(["t-acme"]);
    expect(ids(result.projects)).toEqual(["p-acme", "p-personal"]);
  });

  it("keeps the Project of an open draft", () => {
    const result = filterBySpace({
      spaceId: personal,
      environmentId: env,
      projects,
      threads: [],
      openThreads: [],
      openProject: { environmentId: env, projectId: "p-acme" },
    });
    expect(ids(result.projects)).toEqual(["p-acme", "p-personal"]);
  });

  it("leaves other environments alone, whose Spaces are not this filter's", () => {
    const result = filterBySpace({
      spaceId: acme,
      environmentId: env,
      projects: [project("p", personal, "env-2")],
      threads: [thread("t", "p", personal, "env-2")],
      openThreads: [],
      openProject: null,
    });
    expect(ids(result.threads)).toEqual(["t"]);
    expect(ids(result.projects)).toEqual(["p"]);
  });
});

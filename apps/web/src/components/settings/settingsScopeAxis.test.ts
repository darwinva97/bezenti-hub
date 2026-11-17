import { describe, expect, it } from "vite-plus/test";

import { selectEnvironmentAxis } from "./settingsScopeAxis";

describe("settings scope axes", () => {
  it("drops a checkout narrowing from older links when the machine changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
  });
});

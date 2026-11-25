/**
 * Makita tickets 25–27: a configuration's options of its own, off unless stored, checked on save,
 * and «Every new issue» dated from the moment it is switched on (never before).
 */
import { assert, describe, it } from "@effect/vitest";
import { MAKITA_AUTONOMY_OFF } from "@t3tools/contracts";

import { autonomyNames, checkAutonomy, nextAutonomy, storedAutonomyOf } from "./makitaAutonomy.ts";

describe("makitaAutonomy", () => {
  it("reads every option as off when nothing (or nonsense) is stored", () => {
    for (const json of ["{}", "not json", null, '{"newIssues":"yes"}']) {
      assert.deepEqual(storedAutonomyOf(json), { ...MAKITA_AUTONOMY_OFF, newIssuesSince: null });
    }
    assert.equal(autonomyNames(MAKITA_AUTONOMY_OFF), "none");
  });

  it("refuses values outside their ranges and a bad-work label equal to the trigger label", () => {
    const refused = (patch: Partial<typeof MAKITA_AUTONOMY_OFF>, label: string | null = "makita") =>
      checkAutonomy({ ...MAKITA_AUTONOMY_OFF, ...patch }, label)._tag;
    assert.equal(refused({ closeMinConfidence: 0.4 }), "refused");
    assert.equal(refused({ closeMinConfidence: 1.2 }), "refused");
    assert.equal(refused({ closeMinConfidence: Number.NaN }), "refused");
    assert.equal(refused({ closePerDay: 0 }), "refused");
    assert.equal(refused({ closePerDay: 2.5 }), "refused");
    assert.equal(refused({ closeIdlePrsDays: 6 }), "refused");
    assert.equal(refused({ closeIdlePrsDays: 181 }), "refused");
    assert.equal(refused({ badWorkLabel: "   " }), "refused");
    assert.equal(refused({ badWorkLabel: "Makita" }), "refused");
    assert.equal(refused({ badWorkLabel: "slop", closeIdlePrsDays: 90 }), "ok");
    const checked = checkAutonomy({ ...MAKITA_AUTONOMY_OFF, badWorkLabel: " slop " }, null);
    assert.deepInclude(checked._tag === "ok" ? checked.value : {}, { badWorkLabel: "slop" });
  });

  it("dates «Every new issue» when it is switched on, keeps that date while on, and names what changed", () => {
    const on = nextAutonomy(
      null,
      { ...MAKITA_AUTONOMY_OFF, newIssues: true },
      "2026-11-25T10:00:00.000Z",
    );
    assert.deepEqual(on.changed, ["new_issues"]);
    assert.equal(storedAutonomyOf(on.json).newIssuesSince, "2026-11-25T10:00:00.000Z");
    assert.equal(autonomyNames(on.view), "new-issues");

    const kept = nextAutonomy(
      on.json,
      { ...MAKITA_AUTONOMY_OFF, newIssues: true, closeIssues: true, closePerDay: 3 },
      "2026-11-26T10:00:00.000Z",
    );
    assert.deepEqual(kept.changed, ["close_issues"]);
    assert.equal(storedAutonomyOf(kept.json).newIssuesSince, "2026-11-25T10:00:00.000Z");

    // Left out of an update: the stored options stay as they are.
    assert.deepEqual(nextAutonomy(kept.json, undefined, "2026-11-27T10:00:00.000Z").changed, []);

    const off = nextAutonomy(kept.json, MAKITA_AUTONOMY_OFF, "2026-11-27T10:00:00.000Z");
    assert.deepEqual(off.changed, ["new_issues", "close_issues"]);
    assert.isNull(storedAutonomyOf(off.json).newIssuesSince);
    // Switched on again: from that moment, not from the first time.
    const again = nextAutonomy(
      off.json,
      { ...MAKITA_AUTONOMY_OFF, newIssues: true },
      "2026-11-28T10:00:00.000Z",
    );
    assert.equal(storedAutonomyOf(again.json).newIssuesSince, "2026-11-28T10:00:00.000Z");
  });
});

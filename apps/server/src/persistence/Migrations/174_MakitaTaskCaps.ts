import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 22: how many tasks a configuration has at work at once (3 unless its creator says
// otherwise), and the Owner's ceiling across the Hub (10). More wait in line, queued.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE makita_configs
    ADD COLUMN max_tasks INTEGER NOT NULL DEFAULT 3 CHECK (max_tasks BETWEEN 1 AND 20)
  `;
  yield* sql`
    ALTER TABLE makita_account
    ADD COLUMN max_tasks INTEGER NOT NULL DEFAULT 10 CHECK (max_tasks BETWEEN 1 AND 100)
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Access-keys ticket 07: a Space's access keys are revoked with its deletion from now on; any
// live key of a Space deleted before that is revoked here (`space-gone`). The request check
// refused them already (an unknown Space answers as a revoked key).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE ai_access_keys
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_reason = 'space-gone',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE revoked_at IS NULL AND space_id NOT IN (SELECT space_id FROM spaces)
  `;
});

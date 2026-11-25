import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Makita ticket 07: each Makita configuration's usage apart. The per-request rows name the
// configuration whose Thread made them (NULL for everything else); the daily summary is rebuilt as
// 146 and 160 did, with `makita_config_id` ('' for the rest) in its key. No backfill: no Makita
// Thread ran before this (ticket 05 only reached the integration branch).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE ai_usage ADD COLUMN makita_config_id TEXT`;
  // A configuration's tasks, repositories and callers read its rows of the last 90 days.
  yield* sql`
    CREATE INDEX ai_usage_makita_idx ON ai_usage (makita_config_id, at)
    WHERE makita_config_id IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE ai_usage_daily_new (
      day TEXT NOT NULL,
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      model TEXT NOT NULL,
      grant_id TEXT NOT NULL DEFAULT '',
      -- '' unless an access key made the requests (its user_id is then '').
      access_key_id TEXT NOT NULL DEFAULT '',
      -- '' unless a Makita configuration's Thread made them (user_id is its creator).
      makita_config_id TEXT NOT NULL DEFAULT '',
      requests INTEGER NOT NULL DEFAULT 0,
      failed_requests INTEGER NOT NULL DEFAULT 0,
      unknown_requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      uncached_input_tokens INTEGER,
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, user_id, space_id, account_id, model, grant_id, access_key_id,
        makita_config_id)
    )
  `;
  yield* sql`
    INSERT INTO ai_usage_daily_new (day, user_id, space_id, account_id, model, grant_id,
      access_key_id, requests, failed_requests, unknown_requests, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, uncached_input_tokens, estimated_tokens)
    SELECT day, user_id, space_id, account_id, model, grant_id, access_key_id, requests,
      failed_requests, unknown_requests, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, uncached_input_tokens, estimated_tokens
    FROM ai_usage_daily
  `;
  yield* sql`DROP TABLE ai_usage_daily`;
  yield* sql`ALTER TABLE ai_usage_daily_new RENAME TO ai_usage_daily`;
  yield* sql`CREATE INDEX ai_usage_daily_user_idx ON ai_usage_daily (user_id, day)`;
  yield* sql`CREATE INDEX ai_usage_daily_space_idx ON ai_usage_daily (space_id, day)`;
  yield* sql`
    CREATE INDEX ai_usage_daily_grant_idx ON ai_usage_daily (grant_id, day) WHERE grant_id <> ''
  `;
  yield* sql`
    CREATE INDEX ai_usage_daily_access_key_idx ON ai_usage_daily (access_key_id, day)
    WHERE access_key_id <> ''
  `;
  // A configuration's today / week / month, read by its activity and the Makita lists.
  yield* sql`
    CREATE INDEX ai_usage_daily_makita_idx ON ai_usage_daily (makita_config_id, day)
    WHERE makita_config_id <> ''
  `;
});

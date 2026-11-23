import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Access-keys ticket 04: each access key's daily usage apart (`access_key_id` in the key, '' for
// the rest) and its estimate for answers with no usage. Rebuilt as 146 did; rows of access keys
// written with no key (ticket 01) are summed again per key from the per-request rows.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
      requests INTEGER NOT NULL DEFAULT 0,
      failed_requests INTEGER NOT NULL DEFAULT 0,
      unknown_requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      uncached_input_tokens INTEGER,
      -- Tokens estimated for an access key's answers with no usage (cut short).
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, user_id, space_id, account_id, model, grant_id, access_key_id)
    )
  `;
  yield* sql`
    INSERT INTO ai_usage_daily_new (day, user_id, space_id, account_id, model, grant_id, requests,
      failed_requests, unknown_requests, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, uncached_input_tokens)
    SELECT day, user_id, space_id, account_id, model, grant_id, requests, failed_requests,
      unknown_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      uncached_input_tokens
    FROM ai_usage_daily WHERE user_id <> ''
  `;
  yield* sql`
    INSERT INTO ai_usage_daily_new (day, user_id, space_id, account_id, model, grant_id,
      access_key_id, requests, failed_requests, unknown_requests, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, uncached_input_tokens)
    SELECT day, '', space_id, COALESCE(account_id, ''), COALESCE(model, ''),
      COALESCE(grant_id, ''), access_key_id, COUNT(*),
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),
      SUM(CASE WHEN status < 400 AND input_tokens IS NULL AND output_tokens IS NULL
        THEN 1 ELSE 0 END),
      COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
      COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0),
      COALESCE(SUM(CASE WHEN input_tokens IS NULL THEN 0 WHEN shape = 'anthropic' THEN input_tokens
        ELSE MAX(input_tokens - COALESCE(cache_read_tokens, 0), 0) END), 0)
    FROM ai_usage WHERE access_key_id IS NOT NULL
    GROUP BY day, space_id, COALESCE(account_id, ''), COALESCE(model, ''), COALESCE(grant_id, ''),
      access_key_id
  `;
  yield* sql`DROP TABLE ai_usage_daily`;
  yield* sql`ALTER TABLE ai_usage_daily_new RENAME TO ai_usage_daily`;
  yield* sql`CREATE INDEX ai_usage_daily_user_idx ON ai_usage_daily (user_id, day)`;
  yield* sql`CREATE INDEX ai_usage_daily_space_idx ON ai_usage_daily (space_id, day)`;
  yield* sql`
    CREATE INDEX ai_usage_daily_grant_idx ON ai_usage_daily (grant_id, day) WHERE grant_id <> ''
  `;
  // An access key's caps read its days on every request (access-keys ticket 05).
  yield* sql`
    CREATE INDEX ai_usage_daily_access_key_idx ON ai_usage_daily (access_key_id, day)
    WHERE access_key_id <> ''
  `;
});

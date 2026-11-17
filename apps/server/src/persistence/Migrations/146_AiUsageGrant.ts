import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Grants ticket 03: which Grant each request used, so a Grant's caps and its lender's view count
// it. `ai_usage.grant_id` is NULL for an account the Space owns; `ai_usage_daily` gets `grant_id`
// in its key ('' for own use), rebuilt because SQLite cannot change a primary key. Old rows are own.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE ai_usage ADD COLUMN grant_id TEXT`;
  yield* sql`
    CREATE TABLE ai_usage_daily_new (
      day TEXT NOT NULL,
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      -- '' when a request reached no account or named no model.
      account_id TEXT NOT NULL,
      model TEXT NOT NULL,
      -- '' when the account was the Space's own (or none was reached).
      grant_id TEXT NOT NULL DEFAULT '',
      requests INTEGER NOT NULL DEFAULT 0,
      failed_requests INTEGER NOT NULL DEFAULT 0,
      unknown_requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, user_id, space_id, account_id, model, grant_id)
    )
  `;
  yield* sql`
    INSERT INTO ai_usage_daily_new (day, user_id, space_id, account_id, model, grant_id, requests,
      failed_requests, unknown_requests, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens)
    SELECT day, user_id, space_id, account_id, model, '', requests, failed_requests,
      unknown_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
    FROM ai_usage_daily
  `;
  yield* sql`DROP TABLE ai_usage_daily`;
  yield* sql`ALTER TABLE ai_usage_daily_new RENAME TO ai_usage_daily`;
  yield* sql`CREATE INDEX ai_usage_daily_user_idx ON ai_usage_daily (user_id, day)`;
  yield* sql`CREATE INDEX ai_usage_daily_space_idx ON ai_usage_daily (space_id, day)`;
  // A Grant's caps read its days from a period's start on every request.
  yield* sql`
    CREATE INDEX ai_usage_daily_grant_idx ON ai_usage_daily (grant_id, day) WHERE grant_id <> ''
  `;
});

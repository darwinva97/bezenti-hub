import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Grants ticket 05: the input that did not come from the cache, per daily row, to price it. An
// Anthropic-shaped answer's input leaves the cache out; an OpenAI or Gemini one counts it in, and
// the daily summary keeps no shape. NULL: unknown (its requests were swept), so it has no price.
// Backfilled from the per-request rows only where they still add up to the row's whole input.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE ai_usage_daily ADD COLUMN uncached_input_tokens INTEGER`;
  yield* sql`UPDATE ai_usage_daily SET uncached_input_tokens = 0 WHERE input_tokens = 0`;
  yield* sql`
    UPDATE ai_usage_daily SET uncached_input_tokens = requests.uncached
    FROM (
      SELECT day, user_id, space_id, COALESCE(account_id, '') AS account_id,
        COALESCE(model, '') AS model, COALESCE(grant_id, '') AS grant_id,
        SUM(COALESCE(input_tokens, 0)) AS input,
        SUM(CASE WHEN shape = 'anthropic' THEN COALESCE(input_tokens, 0)
          ELSE MAX(COALESCE(input_tokens, 0) - COALESCE(cache_read_tokens, 0), 0) END) AS uncached
      FROM ai_usage
      GROUP BY day, user_id, space_id, COALESCE(account_id, ''), COALESCE(model, ''),
        COALESCE(grant_id, '')
    ) AS requests
    WHERE ai_usage_daily.input_tokens > 0
      AND ai_usage_daily.day = requests.day
      AND ai_usage_daily.user_id = requests.user_id
      AND ai_usage_daily.space_id = requests.space_id
      AND ai_usage_daily.account_id = requests.account_id
      AND ai_usage_daily.model = requests.model
      AND ai_usage_daily.grant_id = requests.grant_id
      AND ai_usage_daily.input_tokens = requests.input
  `;
});

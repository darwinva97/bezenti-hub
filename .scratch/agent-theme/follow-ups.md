# Agent theme: follow-ups (not built)

- CSP hardening: the Hub serves the web app with no Content-Security-Policy beyond `frame-ancestors` (`apps/server/src/http.ts`), and the desktop CSP allows `img-src http: https:` (`apps/desktop/src/electron/ElectronProtocol.ts`). Add `img-src`/`font-src`/`connect-src`/`style-src` limits as defence in depth for any injected markup or CSS; independent of agent themes.
- `resolveT3McpToolId` accepts a bare or aliased `t3_theme_propose`, so a foreign MCP server named `t3code` (or another alias) could produce a theme card: colours only and a click is still required, but the card should only trust T3's own server identity.
- Re-applying a card overwrites edits the user made to that `agent-…` theme in the theme editor (`updateCustomTheme`); keep edits, or apply under a new id when the stored theme differs from the proposal.
- Applied records (`t3code:theme-proposal-applied:v1:*`) and `agent-…` custom themes are never pruned; drop records of deleted Threads and unused agent themes.
- Theme CSS: `<!--` or `-->` right before an at-rule skips the Hub's at-rule allow-list (`AT_RULE` in `packages/shared/src/themeCss.ts` wants whitespace, `{};/` or start before `@`); the browser's parse still refuses the rule.
- Theme CSS stays in `t3code:theme-css:v1` when its custom theme is deleted in Settings > Appearance; drop it with the theme.
- `?safe-theme=1` does nothing under Electron's hash history (the query sits after `#`, `location.search` is empty); read it from the hash too, or give desktop its own way in.

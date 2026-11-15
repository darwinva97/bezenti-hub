# Agent theme: follow-ups (not built)

- CSP hardening: the Hub serves the web app with no Content-Security-Policy beyond `frame-ancestors` (`apps/server/src/http.ts`), and the desktop CSP allows `img-src http: https:` (`apps/desktop/src/electron/ElectronProtocol.ts`). Add `img-src`/`font-src`/`connect-src`/`style-src` limits as defence in depth for any injected markup or CSS; independent of agent themes.
- `resolveT3McpToolId` accepts a bare or aliased `t3_theme_propose`, so a foreign MCP server named `t3code` (or another alias) could produce a theme card: colours only and a click is still required, but the card should only trust T3's own server identity.
- Re-applying a card overwrites edits the user made to that `agent-…` theme in the theme editor (`updateCustomTheme`); keep edits, or apply under a new id when the stored theme differs from the proposal.
- Applied records (`t3code:theme-proposal-applied:v1:*`) and `agent-…` custom themes are never pruned; drop records of deleted Threads and unused agent themes.

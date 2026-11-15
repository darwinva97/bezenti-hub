# Agent theme tool: port design (upstream 42057b82d0)

Status: design for review. No product code. Base: fork main `819dd04a9f`.

## What upstream does, and what it would do here

Upstream adds MCP tools `t3_theme_read` / `t3_theme_set`. `set` writes a theme file into the
server's `themes/` folder and sets `defaultTheme` (+ new `defaultAppearance`) in the server's
settings. Every browser adopts the primary server's default once per change
(`useDefaultTheme.ts`). Themes may carry `css`, injected as an adopted stylesheet.

In our fork, `/mcp` is a Hub door: joined machines and Sandboxes forward `/mcp` to the Hub
(`docs/internals/sandboxes.md`, `DoorRules.ts`), so the handlers run in the Hub process. Ported as
is, an agent in any User's Thread would write the **Hub's** settings and themes folder, and the
web app reads its default theme from the primary server (`primaryServerSettingsAtom`, the Hub). One
agent would restyle (and inject CSS into) every User's interface on the Installation. It would also
skip our settings check: upstream's handler never calls `authorizeAsRpc(serverUpdateSettings)`,
which our `t3_environment_preferences_update` does. **Do not port the write path.**

## 1. Whose appearance: the viewer's own, by their click

Where the state lives today: the Hub's server settings are Installation-wide (the Owner's,
`AuthSettingsWriteScope`); a User's chosen theme, custom themes and light/dark mode live only in
that browser's `localStorage` (`useTheme.ts`, `themePalette.ts`). There is **no per-User settings
store on the Hub** (`users` has no preferences; no such table up to migration 118).

Recommendation: the agent **proposes**, it does not apply. `t3_theme_propose` validates a theme
and returns it as the tool result; nothing on the Hub or any machine is written. The Thread
timeline shows the result as a card (swatches, name, light/dark) with **Preview**, **Apply to my
appearance** and, after applying, **Undo**. Applying saves it as a custom theme in that browser and
selects it, using the existing theme code. So an agent in User A's Thread can never change User B's
interface: B sees the card only if B can see the Thread, and nothing changes unless B clicks. Guests
(read-only links) get no buttons. No migration.

Your starting position (stored with the Thread owner's settings on the Hub, applied without a
click) is possible but needs new storage: a `user_appearance` table (migration 119), an RPC/stream
to deliver it, adoption logic per User across devices, and an undo there. Roughly double the
ticket, and it leaves a prompt injection one tool call away from changing the owner's screen. I
recommend it only if the Owner wants zero-click (question 1).

## 2. Custom CSS: colors only for agents

Upstream's guard: the server does a text check (comments stripped, refuses `@import`,
`image-set(`, `src(`, `url(` unless `data:`/`#`), documented as bypassable; the real guard is
client-side (`apps/web/src/themeCss.ts`): parse into an adopted sheet (no `@import` possible),
delete every declaration whose value contains `\`, `image-set(`, `src(` or a non-`data:`/`#`
`url(`, drop `@property` with fetching initial values and any unknown at-rule. Against
**exfiltration** this is sound: attribute-selector and font tricks all need a fetch, and it blocks
the fetch. But it is the **only** line: the Hub serves the web app with no CSP beyond
`frame-ancestors` (`http.ts`), and the desktop CSP allows `img-src http: https:`. One sanitiser
bug equals a working exfil channel for whatever is on screen (Vault values are masked as `[NAME]`
in history, but file previews, diffs and terminals of unmasked content are on screen too).

The bigger problem is **deception**, which no value filter addresses: `display:none` on the
approval row, `order`/`row-reverse` to swap Approve and Deny, `::before { content }` to relabel
buttons, hiding `[NAME]` chips or the AI account in use, overlays with `position:fixed`. A prompt
injection in a repo can make the agent do this; the selector list upstream hands the agent
(`THEME_CSS_HOOKS`) is a map of where to aim.

Recommendation: agents send **colors only**: `appearance` + `canvas` + `accent` (the app derives the
full palette with `createVividThemeColors`), plus optional `variants` with the same two fields. No
`css`, no per-role `colors` overrides (those can set text = background or make Deny green). Refuse
unknown keys rather than strip them, so the agent learns `css` is not accepted. Do not port
`themeCss.ts`, `ThemeCssEditor.tsx`, the CSS guide or the `css` contract field in this ticket.
If the Owner later wants a human-only CSS editor for one's own local themes, the sanitiser must at
least refuse: any `\`; `url(` except `data:image/(png|jpeg|gif|webp)` and `#id`; `image-set(`,
`-webkit-image-set(`, `src(`, `image(`, `element(`, `cross-fade(` with a url; `@import`,
`@font-face`, `@property`, unknown at-rules; and never travel via the Hub or shared theme imports
(question 2).

## 3. Who may call

`t3_theme_read` (built-in ids, the Owner's published themes, a colors-only guide): `reads`,
DoorRules `own("built-in and published theme names; no Space data")`. `t3_theme_propose`:
`actsAsCaller` (a live Thread caller; outside MCP clients and read-only clients refused), DoorRules
`OWN_THREAD`. No Role check is needed because it writes nothing; the card's Apply acts as the viewer
in their own browser, so the viewer's Role does not matter either. No full-access requirement
(upstream needed it because `set` wrote settings).

## 4. Undo

The card's **Undo** restores the theme that was selected before Apply (kept with the card's applied
record in `localStorage`). Plus what exists: Settings > Appearance, and Cmd+Option+A / Ctrl+Alt+A to
pick a built-in theme. Colors are derived from canvas + accent, so text keeps contrast; a red test
asserts foreground on background in the derived palette keeps 4.5:1 for sampled canvas/accent
pairs (if the generator does not guarantee it, the handler refuses pairs that fail).

## 5. Port plan (one ticket, size M: about 2 days, ~600 lines with tests)

Take, adapted: `toolkits/theme/{tools,handlers}.ts` (rewritten: read + propose, no
`EnvironmentThemeService` dependency), the colors half of `THEME_GUIDE`, the
`t3McpToolPresentation`/`t3ToolSummary`/work-log hunks (`theme-propose`), the
`CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS` line for `t3_theme_read`, the eval cases (rewritten for
propose; fork has `evals/mcp-tool-use/cases`). Hand-apply: the three lines in `McpHttpServer.ts`
(file differs by ~520 lines but the toolkit list is the same shape), `agentContextBudget.json`
(ours is 45394; re-measure, expect about +900). New: the timeline card (web), DoorRules entries,
`docs/user/appearance.md` "Ask an agent" in our words.

Skip: `environmentTheme.ts` publish/apply, `server.ts` layer reorder (only needed for apply),
`settings.ts`/`rpc.ts` (`defaultAppearance`, `ClientServerSettingsPatch`), `useDefaultTheme.ts`
appearance adoption, all CSS files, the `data-slot` hooks. That avoids every conflicting file in the
brief (ThemeEditorPanel, settings contracts, `server.ts`). Prerequisites: none.
`ce9b80671b` (BOM), `67fdc53823` (desktop theme server) and `88109cea46` are not needed for this.

Tests first (red): handler returns a normalized proposal for valid colors; refuses `css`, `colors`
and bad hex with `invalid_request`; a mocked `ServerSettingsService`/file system that fails if
touched proves nothing is written; a caller without a Thread is refused; `DoorRules.test` fails
until both tools have rules; budget test; web: a proposal arriving calls no `setTheme`, Apply sets
it in this browser only, Undo restores the previous theme, guest view has no buttons; palette
contrast test.

## Risks not closed

- The Hub web app has no CSP for images/fonts/connect; a separate hardening ticket.
- Proposals stay in Thread history; an old card can be applied later (harmless: colors only).
- Applying is per browser; the User's other devices do not follow (as themes behave today).

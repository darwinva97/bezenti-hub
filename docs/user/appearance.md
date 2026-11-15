# Appearance and themes

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, select
the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Math

Turn on **Render math** in **Settings → Appearance** to typeset LaTeX in messages and Markdown
previews on web, desktop, and mobile. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a T3 Code or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Ask an agent for a theme

Ask the agent in a thread to give T3 Code a new look, for example "make T3 Code look like a
late-night terminal". It does not change anything itself: it proposes a theme, which appears as a
card in the thread with its name, appearance (light or dark), colors, and whether it carries custom
CSS.

- **Preview** shows the theme in your window until you stop the preview.
- **Apply to my appearance** adds the theme to your custom themes and selects it.
- **Undo** puts back the theme, light or dark mode, and light/dark mix you had before. If you have
  picked another theme since, the card offers Apply again instead.

Applying acts only on your appearance in the browser or desktop app where you click. Everyone else
who can see the thread sees the same card and is not restyled unless they apply it themselves. Your
other devices keep their own theme. A guest link shows the card without buttons, and the mobile app
shows a line saying a theme was proposed.

What an agent can and cannot do:

- It can propose a name, light or dark, a background color and an accent color. T3 Code derives
  every other color from those two and checks that text stays readable.
- It can add custom CSS, up to 50,000 characters: animations, borders, shapes, spacing, hiding or
  moving parts of the page.
- It cannot add individual colors, cannot change the server's default theme, and cannot change
  anyone's appearance. A proposal that would be hard to read (a dark theme on a mid-grey or light
  background, or an accent that disappears on the background) is refused.

To go back at any time, use **Undo** on the card, choose another theme in **Settings → Appearance**,
or press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker.

### Custom CSS

A card whose proposal carries CSS says **Includes custom CSS: it can change how anything on the
page looks, including buttons**, with its size. Read it before you click: CSS can hide, move or
relabel anything, an Approve or Deny button included. Apply only CSS you asked for, from an agent
you trust. Preview and Apply work as for colors; **Undo** removes the CSS completely.

The CSS cannot load or send anything. T3 Code refuses a proposal whose CSS uses `url()` (except an
inline `data:image` in PNG, JPEG, GIF, WebP or AVIF, or a `#id` reference), `@import`,
`@font-face`, `image-set()`, `image()`, `src`, `attr()`, `expression()`, `behavior`,
`-moz-binding`, any backslash escape, or at-rules other than `@media`, `@supports`, `@container`,
`@layer` and `@keyframes`. The server checks it when the agent proposes, and your browser checks it
again with today's rules before Preview or Apply, also for an old card.

Only a proposal made by this T3 Code server's own theme tool keeps its CSS. A card that comes from
another tool, even one with the same name, shows its colors only.

The CSS is kept only in the browser or desktop app where you applied it, with that custom theme. It
is not exported with the theme, not sent to the server, and not seen by anyone else. Choosing another
theme turns it off; choosing that theme again turns it back on. Signing out removes all custom
theme CSS from that browser.

If the CSS makes T3 Code unusable, two ways out work without seeing the page:

- Press **Cmd+Option+Shift+0** on macOS or **Ctrl+Alt+Shift+0** on Windows/Linux. It removes all
  custom theme CSS from this browser and, if a theme with CSS was showing, goes back to the theme
  you had before you first applied one. It works wherever the focus is, and cannot be rebound.
- Open T3 Code with `?safe-theme=1` at the end of its address, for example
  `https://your-server/?safe-theme=1`. It loads with no custom theme CSS and offers **Remove custom
  theme CSS**. Until you reload without it, custom CSS stays off.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. Additional connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, T3 Code falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
t3 theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `t3 theme set`. Run the command again to
reapply it, even if the name is unchanged.

`t3 theme clear` removes the default without changing anyone's current theme. `t3 theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from T3 Code into `~/.t3/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `t3 theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. T3 Code
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.

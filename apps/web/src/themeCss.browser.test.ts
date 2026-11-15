import { expect, it } from "vite-plus/test";

import {
  checkThemeCss,
  serializeCheckedThemeCss,
  showThemeCss,
  THEME_CSS_STYLE_ELEMENT_ID,
} from "./themeCss";

// Upstream's adversarial sheet (42057b82d0), minus @namespace, which CSSOM cannot delete while
// style rules remain (checkThemeCss refuses that sheet whole; see the last test).
const ADVERSARIAL = `
  @import url(https://example.com/sheet.css);
  @property --registered { syntax: "<url>"; inherits: false; initial-value: url(https://example.com/d); }
  @counter-style leak { system: cyclic; symbols: url(https://example.com/f); }
  @font-face { font-family: leak; src: url(https://example.com/font.woff2); }
  @keyframes leak { to { background-image: url(https://example.com/g); } }
  :root { --leak: u\\72l(https://example.com/a); }
  [data-theme-css-probe] {
    color: rgb(1, 2, 3);
    background-image: u\\72l(https://example.com/b);
    list-style-image: var(--leak);
    border-image-source: var(--registered);
    mask-image: v\\61r(--none, u\\72l(https://example.com/e));
    @media (min-width: 0px) { cursor: url(https://example.com/c), auto; }
  }
`;

it("refuses the adversarial sheet whole on its text", () => {
  expect(checkThemeCss(ADVERSARIAL).ok).toBe(false);
});

it("still drops every rule and value that would load, if the text check were bypassed", () => {
  const kept = serializeCheckedThemeCss(ADVERSARIAL);
  expect(kept).toContain("rgb(1, 2, 3)");
  expect(kept).not.toContain("example.com");
  expect(kept).not.toMatch(/@import|@property|@counter-style|@font-face/);
  expect(kept).not.toContain("\\");
});

it("refuses a sheet whose @namespace the parser cannot drop", () => {
  expect(
    checkThemeCss("@namespace svg url(http://www.w3.org/2000/svg); .x { color: red }").ok,
  ).toBe(false);
});

it("shows CSS through one element of its own, replaces it, and removes it", () => {
  const probe = document.createElement("div");
  probe.dataset.themeCssProbe = "";
  document.body.append(probe);
  using _probe = { [Symbol.dispose]: () => probe.remove() };
  using _css = { [Symbol.dispose]: () => showThemeCss(null) };

  showThemeCss("[data-theme-css-probe] { color: rgb(1, 2, 3); }");
  expect(getComputedStyle(probe).color).toBe("rgb(1, 2, 3)");
  showThemeCss("[data-theme-css-probe] { color: rgb(4, 5, 6); }");
  expect(getComputedStyle(probe).color).toBe("rgb(4, 5, 6)");
  expect(document.querySelectorAll(`#${THEME_CSS_STYLE_ELEMENT_ID}`)).toHaveLength(1);
  expect(document.head.lastElementChild?.id).toBe(THEME_CSS_STYLE_ELEMENT_ID);

  // Refused CSS shows nothing, not even what was there.
  showThemeCss("[data-theme-css-probe] { background: url(https://example.com/a) }");
  expect(document.getElementById(THEME_CSS_STYLE_ELEMENT_ID)).toBeNull();
  expect(getComputedStyle(probe).color).not.toBe("rgb(4, 5, 6)");

  showThemeCss("[data-theme-css-probe] { color: rgb(1, 2, 3); }");
  showThemeCss(null);
  expect(document.getElementById(THEME_CSS_STYLE_ELEMENT_ID)).toBeNull();
});

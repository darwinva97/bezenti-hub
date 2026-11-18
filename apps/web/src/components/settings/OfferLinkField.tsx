import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** «Lend to» a Space not in the list: by a lending link (Grants tickets 06 and 15). */
export const BY_LINK = "by-link";
export const BY_LINK_LABEL = "Someone else's Space: make a link";

/** A lending link just made, shown once, to copy. */
export function OfferLinkField({
  link,
  onCopyFailed,
}: {
  readonly link: string;
  readonly onCopyFailed: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      onCopyFailed();
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Lending link"
        nativeInput
        readOnly
        value={link}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button size="sm" type="button" variant="outline" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

import { aiAccountPickerLabel } from "@t3tools/client-runtime/ai-account-picker";
import type { AiAccountId, AiAccountPickerAccount } from "@t3tools/contracts";
import { memo } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";

/**
 * Spec 4 ticket 08: the composer's AI account, among those allowed to the User in the Thread's
 * Space that the selected provider can use with the selected model, first by priority. Mid-Thread
 * the change goes to the Hub at once (`thread.setAiAccount`); on a draft it goes with the send.
 */
export const ComposerAiAccountSelect = memo(function ComposerAiAccountSelect(props: {
  readonly accounts: ReadonlyArray<AiAccountPickerAccount>;
  readonly value: AiAccountId | null;
  readonly disabled?: boolean;
  readonly size: "xs" | "sm";
  readonly onChange: (accountId: AiAccountId) => void;
}) {
  const selected = props.accounts.find((account) => account.id === props.value) ?? null;
  return (
    <div className="max-w-40 min-w-0 shrink" data-composer-ai-account>
      <Select
        value={selected?.id ?? null}
        disabled={props.disabled === true || props.accounts.length === 0}
        onValueChange={(value) => {
          if (value !== null && value !== props.value) props.onChange(value as AiAccountId);
        }}
      >
        <SelectTrigger size={props.size} aria-label="AI account">
          <span className="truncate">{selected?.name ?? "AI account"}</span>
        </SelectTrigger>
        <SelectPopup side="top" alignItemWithTrigger={false}>
          {props.accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {aiAccountPickerLabel(account)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
});

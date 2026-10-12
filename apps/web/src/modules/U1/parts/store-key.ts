import type { MessageState } from "@assistant-ui/react";

/**
 * A message's store key: its persisted entry's key (`entry:<thread>:<entry>`) once history has it, or its live key while
 * it streams. The row's id can stay the key of its streamed copy after the entry replaces that copy (issue 1047), so the
 * element's `data-store-key`, the reading place and the execution record use this key instead.
 */
export function storeKeyOf(message: MessageState): string {
  const key = message.metadata.custom.ompMessageKey;
  return typeof key === "string" ? key : message.id;
}

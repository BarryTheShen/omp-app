import { type ReactNode, useMemo } from "react";
import type { OmpRuntimeStore } from "@/modules/R0/store/store";
import { createStorePromptSource, PromptHistorySlot } from "@/modules/U2/history";

/**
 * Up and Down recall the prompts this chat's user sent (U2.5). The slot sits outside the composer, so
 * it sees an arrow only after the composer and any open trigger list have handled it.
 */
export function ComposerHistory({
  store,
  children,
}: {
  readonly store: OmpRuntimeStore;
  readonly children: ReactNode;
}) {
  const source = useMemo(() => createStorePromptSource(store), [store]);
  return <PromptHistorySlot source={source}>{children}</PromptHistorySlot>;
}

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PanelOpenReason } from "@/modules/U5/panel/contract";
import type { BtwRpcController } from "./btw-rpc";
import type { BtwPanelProps } from "./panels";
import { operationsViews } from "./panels";

const BtwPanel = operationsViews.btw;

export interface BtwRpcPanelProps
  extends Omit<BtwPanelProps, "model" | "onCopy" | "onCancel" | "onSelect"> {
  readonly controller: BtwRpcController;
}

/** D6's production seam: the existing Side questions panel driven by typed btw RPC state. */
function BtwRpcPanel({ controller, onBranch, ...props }: BtwRpcPanelProps) {
  const [copyError, setCopyError] = useState<string | undefined>();
  const model = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const panelModel = copyError
    ? {
        ...model,
        error: { code: "internal" as const, message: copyError, retryable: false },
      }
    : model;
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const onSelect = useCallback((id: string): void => controller.select(id), [controller]);
  const onCopy = useCallback((): void => {
    const selected = model.turns.find((turn) => turn.id === model.selectedId);
    if (selected?.answer === undefined || typeof navigator === "undefined") return;
    if (navigator.clipboard === undefined) {
      setCopyError("The answer could not be copied.");
      return;
    }
    setCopyError(undefined);
    void navigator.clipboard.writeText(selected.answer).catch(() => {
      setCopyError("The answer could not be copied.");
    });
  }, [model.selectedId, model.turns]);
  const onCancel = useCallback((): void => {
    void controller.cancel(model.selectedId ?? undefined).catch(() => undefined);
  }, [controller, model.selectedId]);
  const onOpenChange = useCallback(
    (open: boolean, reason: PanelOpenReason): void => props.onOpenChange?.(open, reason),
    [props.onOpenChange],
  );
  return (
    <BtwPanel
      {...props}
      model={panelModel}
      onBranch={onBranch}
      onCancel={onCancel}
      onCopy={onCopy}
      onOpenChange={onOpenChange}
      onSelect={onSelect}
    />
  );
}

export const btwRpcViews = { panel: BtwRpcPanel } as const;

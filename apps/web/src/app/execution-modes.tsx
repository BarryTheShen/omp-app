import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import { SlidersHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { Surface } from "@/layout";
import {
  ConnectedModeControls,
  createModeCommandGateway,
  createModeController,
  createModeRpc,
  D7_EXECUTION_MODES_COMMAND,
  type ModeController,
} from "@/modules/D7/modes";
import { type OverlayHostApi, useStableOverlayHost } from "@/overlay";
import { useShortcutRegistry } from "@/shortcuts";
import { composerInput } from "./composer-input";

export interface ExecutionModesOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  /** Told when omp refuses a Fast mode change; the app lets go of omp's notice about it. */
  readonly onFastRefused?: () => void;
}

interface ExecutionModesDialogOptions {
  readonly overlay: OverlayHostApi;
  readonly controller: ModeController;
  /** Where focus goes back when the dialog closes; omitted, the focused opener is used. */
  readonly restoreFocus?: HTMLElement;
}

/**
 * Opens D7's execution-mode controls in a dialog. The controller belongs to the chat, not to the dialog,
 * so a mode omp does not report keeps the choice made in this chat when the dialog closes and opens again.
 */
function openExecutionModesDialog({
  overlay,
  controller,
  restoreFocus,
}: ExecutionModesDialogOptions): void {
  overlay.open({
    kind: "modal",
    label: "Execution modes",
    // A roomy box, as the model dialog has: each setting's description needs more than the narrow content width.
    className: "w-[min(calc(100vw-1rem),40rem)] max-w-none",
    ...(restoreFocus === undefined ? {} : { restoreFocus }),
    content: ({ close }) => (
      <div className="flex min-w-0 flex-col gap-4">
        <ConnectedModeControls controller={controller} />
        <Button className="self-end" onClick={() => close()} type="button" variant="outline">
          Done
        </Button>
      </div>
    ),
  });
}

/**
 * The composer toolbar's button. Below the 48 rem (768 px) breakpoint it is only an icon, so the toolbar keeps room
 * for the input modes beside it; its name stays on the button for assistive technology and as the hover hint.
 */
function ExecutionModesButton({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <Button
      aria-haspopup="dialog"
      aria-label="Execution modes"
      className="text-muted-foreground hover:text-foreground rounded-control h-7 px-2 text-sm font-normal transition-colors"
      onClick={onOpen}
      size="xs"
      title="Execution modes"
      type="button"
      variant="ghost"
    >
      <SlidersHorizontalIcon aria-hidden="true" className="size-4 md:hidden" />
      <span className="hidden md:inline">Execution modes</span>
    </Button>
  );
}

/**
 * The composer toolbar's execution-modes control for the open chat. One controller is made per chat and
 * disposed when the chat changes; capability changes reach it through `setCapabilities`. The palette's
 * "Execution modes" command opens the same dialog, and focus returns to the composer when it closes.
 */
export function useExecutionModesSurface({
  client,
  threadId,
  capabilities,
  onFastRefused,
}: ExecutionModesOptions): Surface {
  const overlay = useStableOverlayHost();
  const shortcuts = useShortcutRegistry();
  // The newest capabilities, read when the chat's controller is made; later changes reach it below.
  const capabilitiesRef = useRef(capabilities);
  useLayoutEffect(() => {
    capabilitiesRef.current = capabilities;
  });
  // The refusal callback is read through a ref, so a new callback does not make the chat's controller again.
  const onFastRefusedRef = useRef(onFastRefused);
  useLayoutEffect(() => {
    onFastRefusedRef.current = onFastRefused;
  });
  const controller = useMemo(
    () =>
      createModeController({
        threadId,
        capabilities: capabilitiesRef.current,
        gateway: createModeCommandGateway(client),
        rpc: createModeRpc(client, threadId),
        onFastRefused: () => onFastRefusedRef.current?.(),
      }),
    [client, threadId],
  );
  useEffect(() => {
    controller.setCapabilities(capabilities);
  }, [controller, capabilities]);
  useEffect(() => () => controller.dispose(), [controller]);

  const open = useCallback(
    (restoreFocus?: HTMLElement) => openExecutionModesDialog({ overlay, controller, restoreFocus }),
    [controller, overlay],
  );
  // A ref keeps the palette registration steady while the chat's controller changes.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(
    () =>
      shortcuts.registerCommand(D7_EXECUTION_MODES_COMMAND.id, {
        run: () => openRef.current(composerInput() ?? undefined),
      }),
    [shortcuts],
  );

  return {
    title: "Execution modes",
    render: () => (
      <span className="flex h-7">
        <ExecutionModesButton onOpen={() => open()} />
      </span>
    ),
  };
}

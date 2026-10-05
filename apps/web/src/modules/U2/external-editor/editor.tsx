import type { CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { PencilIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import type { ExternalEditorAdapter } from "../contract";
/** The TUI's Ctrl+G handoff is cited by omp v18.6.1 `src/modes/controllers/input-controller.ts:2084-2110`; hosts provide the browser adapter. */

export const EXTERNAL_EDITOR_CAPABILITY = "host.external-editor" as const;

export interface ExternalEditorControllerOptions {
  readonly adapter?: ExternalEditorAdapter;
  readonly capabilities?: CapabilityMap;
}

export interface ExternalEditorAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/** Serving-independent adapter boundary; hosts provide the real $VISUAL/$EDITOR integration. */
export class ExternalEditorController {
  private readonly adapter: ExternalEditorAdapter | undefined;
  private readonly capabilities: CapabilityMap | undefined;

  public constructor(options: ExternalEditorControllerOptions) {
    this.adapter = options.adapter;
    this.capabilities = options.capabilities;
  }

  public availability(): ExternalEditorAvailability {
    if (this.adapter === undefined) {
      return { available: false, reason: "External editor is unavailable in this host." };
    }
    const capability = this.capabilities?.[EXTERNAL_EDITOR_CAPABILITY];
    if (capability !== undefined && capability.state !== "available") {
      return {
        available: false,
        reason: capability.detail ?? "External editor capability is unavailable.",
      };
    }
    return { available: true };
  }

  public async open(initialText: string, signal?: AbortSignal): Promise<string> {
    const availability = this.availability();
    if (!availability.available) {
      throw new AppFailure({
        code: "unavailable",
        message: availability.reason ?? "External editor is unavailable.",
        retryable: false,
        capability: EXTERNAL_EDITOR_CAPABILITY,
      });
    }
    const adapter = this.adapter;
    if (adapter === undefined) {
      throw new AppFailure({
        code: "unavailable",
        message: "External editor is unavailable.",
        retryable: false,
        capability: EXTERNAL_EDITOR_CAPABILITY,
      });
    }
    try {
      return await adapter.open({ initialText, signal });
    } catch (error) {
      if (error instanceof AppFailure) throw error;
      throw new AppFailure(
        {
          code: "internal",
          message: "External editor failed; your draft was preserved.",
          retryable: true,
        },
        { cause: error },
      );
    }
  }
}

export interface ExternalEditorButtonProps {
  readonly text: string;
  readonly adapter?: ExternalEditorAdapter;
  readonly capabilities?: CapabilityMap;
  readonly onText: (text: string) => void;
  readonly onError?: (error: AppFailure) => void;
}

/** A capability-gated editor button; it never fakes an editor when no host adapter exists. */
export function ExternalEditorButton({
  text,
  adapter,
  capabilities,
  onText,
  onError,
}: ExternalEditorButtonProps) {
  const controller = useRef(new ExternalEditorController({ adapter, capabilities }));
  const [opening, setOpening] = useState(false);
  const [availability, setAvailability] = useState(() => controller.current.availability());
  useEffect(() => {
    controller.current = new ExternalEditorController({ adapter, capabilities });
    setAvailability(controller.current.availability());
  }, [adapter, capabilities]);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort("External editor component unmounted"), []);
  const open = async (): Promise<void> => {
    setOpening(true);
    const current = new AbortController();
    abort.current = current;
    try {
      onText(await controller.current.open(text, current.signal));
    } catch (error) {
      const failure =
        error instanceof AppFailure
          ? error
          : new AppFailure(
              { code: "internal", message: "External editor failed.", retryable: true },
              { cause: error },
            );
      onError?.(failure);
    } finally {
      if (abort.current === current) abort.current = undefined;
      setOpening(false);
    }
  };
  return (
    <div className="relative -mt-9 ms-8 mb-2 h-7 w-7">
      <Button
        aria-describedby={!availability.available ? "external-editor-reason" : undefined}
        aria-label="Open external editor"
        disabled={!availability.available || opening}
        title={availability.reason}
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void open()}
      >
        <PencilIcon aria-hidden="true" className="size-4" />
      </Button>
      {!availability.available && (
        <span id="external-editor-reason" className="sr-only">
          {availability.reason}
        </span>
      )}
    </div>
  );
}

import { AppFailure } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import {
  P6_QUEUE_CAPABILITIES,
  type QueueMode,
  type QueuePort,
  type QueueSnapshot,
} from "../contract";

/**
 * v18.6.1's RPC docs state that abort drops in-flight queued messages; P6 never invents a second
 * queue state. A pending chip can be restored to the composer through the researched Alt+Up
 * dequeue action while it remains in R0.5's authoritative snapshot.
 * Source: .data/ref/omp-v18.6.1/docs_rpc.md:742-745 and research/modules/P6.md:48.
 */
export const QUEUE_CANCELLATION_POLICY =
  "Stopping a turn (Esc) drops queued messages omp has not delivered yet. Alt+Up puts the last queued message back in the editor.";

export interface QueueModeSelectorProps {
  readonly port: QueuePort;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

type DraftModes = Pick<QueueSnapshot, "steeringMode" | "followUpMode" | "interruptMode">;

const MODE_OPTIONS: readonly { readonly value: QueueMode; readonly label: string }[] = [
  { value: "one-at-a-time", label: "One at a time" },
  { value: "all", label: "All" },
];

const MODE_DESCRIPTIONS = {
  steering: {
    "one-at-a-time": "One at a time: deliver one queued steering message per tool boundary.",
    all: "All: deliver queued steering messages together at the next boundary.",
  },
  followUp: {
    "one-at-a-time": "One at a time: deliver one queued message per completed turn.",
    all: "All: deliver queued messages together after the turn.",
  },
  interrupt: {
    immediate: "Immediate: request cooperative interruption as soon as possible.",
    wait: "Wait: let side-effecting work reach a cooperative boundary first.",
  },
} as const;

function failureMessage(error: unknown): string {
  if (error instanceof AppFailure) return error.appError.message;
  return "Queue mode changes could not be saved.";
}

function SegmentedModeControl<Value extends string>({
  ariaLabel,
  disabled,
  options,
  value,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly value: Value;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <fieldset aria-label={ariaLabel} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <Button
          aria-pressed={option.value === value}
          className={
            option.value === value
              ? "bg-secondary text-secondary-foreground ring-2 ring-primary/30"
              : "text-muted-foreground"
          }
          disabled={disabled}
          key={option.value}
          size="sm"
          type="button"
          variant={option.value === value ? "secondary" : "ghost"}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </fieldset>
  );
}

export function QueueModeSelector({ port, open, onOpenChange }: QueueModeSelectorProps) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(() => port.getSnapshot());
  const [draft, setDraft] = useState<DraftModes>(() => ({
    steeringMode: snapshot.steeringMode,
    followUpMode: snapshot.followUpMode,
    interruptMode: snapshot.interruptMode,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => port.subscribe(setSnapshot), [port]);
  useEffect(() => {
    if (!open) return;
    setDraft({
      steeringMode: snapshot.steeringMode,
      followUpMode: snapshot.followUpMode,
      interruptMode: snapshot.interruptMode,
    });
    setError(undefined);
  }, [open, snapshot.followUpMode, snapshot.interruptMode, snapshot.steeringMode]);

  const save = async () => {
    const changes: DraftModes = {
      steeringMode: draft.steeringMode,
      followUpMode: draft.followUpMode,
      interruptMode: draft.interruptMode,
    };
    const capabilities = port.getCapabilities();
    const capabilityFor = {
      steeringMode: P6_QUEUE_CAPABILITIES.steeringMode,
      followUpMode: P6_QUEUE_CAPABILITIES.followUpMode,
      interruptMode: P6_QUEUE_CAPABILITIES.interruptMode,
    } as const;
    for (const key of Object.keys(capabilityFor) as (keyof DraftModes)[]) {
      if (changes[key] === snapshot[key]) continue;
      const capability = capabilityFor[key];
      if (capabilities[capability]?.state !== "available") {
        setError(`Queue mode changes are unavailable (${capability}).`);
        return;
      }
    }
    setSaving(true);
    setError(undefined);
    try {
      await port.setModes({
        steeringMode:
          changes.steeringMode === snapshot.steeringMode ? undefined : changes.steeringMode,
        followUpMode:
          changes.followUpMode === snapshot.followUpMode ? undefined : changes.followUpMode,
        interruptMode:
          changes.interruptMode === snapshot.interruptMode ? undefined : changes.interruptMode,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Queue modes</DialogTitle>
          <DialogDescription>
            Modes apply to this session only. Steering interrupts the active turn; queued messages
            wait for the current turn to settle.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <fieldset className="grid gap-1.5 text-sm">
            <legend className="font-medium">Steering</legend>
            <SegmentedModeControl
              ariaLabel="Steering mode"
              disabled={saving}
              options={MODE_OPTIONS}
              value={draft.steeringMode}
              onChange={(value) => setDraft((current) => ({ ...current, steeringMode: value }))}
            />
            <p className="text-muted-foreground text-xs">
              {MODE_DESCRIPTIONS.steering[draft.steeringMode]}
            </p>
          </fieldset>
          <fieldset className="grid gap-1.5 text-sm">
            <legend className="font-medium">After this turn</legend>
            <SegmentedModeControl
              ariaLabel="After this turn mode"
              disabled={saving}
              options={MODE_OPTIONS}
              value={draft.followUpMode}
              onChange={(value) => setDraft((current) => ({ ...current, followUpMode: value }))}
            />
            <p className="text-muted-foreground text-xs">
              {MODE_DESCRIPTIONS.followUp[draft.followUpMode]}
            </p>
          </fieldset>
          <fieldset className="grid gap-1.5 text-sm">
            <legend className="font-medium">Interrupt</legend>
            <SegmentedModeControl
              ariaLabel="Interrupt mode"
              disabled={saving}
              options={[
                { value: "immediate" as const, label: "Immediate" },
                { value: "wait" as const, label: "Wait" },
              ]}
              value={draft.interruptMode}
              onChange={(value) => setDraft((current) => ({ ...current, interruptMode: value }))}
            />
            <p className="text-muted-foreground text-xs">
              {MODE_DESCRIPTIONS.interrupt[draft.interruptMode]}
            </p>
          </fieldset>
          <p className="text-muted-foreground text-xs">{QUEUE_CANCELLATION_POLICY}</p>
          {error !== undefined && (
            <p aria-live="assertive" className="text-danger text-sm" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            disabled={saving}
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={saving} type="button" onClick={() => void save()}>
            {saving ? "Saving…" : "Save modes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

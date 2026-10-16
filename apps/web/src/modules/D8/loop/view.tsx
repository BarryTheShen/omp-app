import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { InlineError, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LoopGate } from "./gate";
import { type LoopConditionMode, type LoopForm, type LoopSpec, loopSpecFromForm } from "./spec";

export type LoopRunState = "idle" | "running" | "paused";

export interface LoopControlsProps {
  readonly gate: LoopGate;
  readonly run: LoopRunState;
  readonly onStart: (spec: LoopSpec) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
}

const MODE_OPTIONS: ReadonlyArray<{ readonly value: LoopConditionMode; readonly label: string }> = [
  { value: "until", label: "Stop once this command succeeds" },
  { value: "while", label: "Keep going while this command succeeds" },
];

const EMPTY_FORM: LoopForm = { count: "", minutes: "", command: "", mode: "until" };

/**
 * Loop controls: shown only when the loop capability is published. Without it the section says why
 * loops are absent and offers no control, so nothing can be started by this app.
 */
export function LoopControls({ gate, run, onStart, onPause, onResume, onStop }: LoopControlsProps) {
  const headingId = useId();
  const focusAfterStart = useRef(false);
  const [form, setForm] = useState<LoopForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (run !== "idle" && focusAfterStart.current) {
      firstActionRef.current?.focus();
      focusAfterStart.current = false;
    }
  }, [run]);

  if (gate.state === "unavailable") {
    return (
      <Section
        description="Run the same work again and again, with a count, a time limit or a stop condition."
        heading="Loop"
        headingId={headingId}
        variant="plain"
      >
        <p className="text-muted-foreground text-sm" role="status">
          {gate.reason}
        </p>
      </Section>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = loopSpecFromForm(form);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    setFormError(null);
    onStart(result.spec);
    focusAfterStart.current = true;
  };

  const setField = (field: keyof LoopForm, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
  };

  return (
    <Section
      description="Run the same work again and again, with a count, a time limit or a stop condition."
      heading="Loop"
      headingId={headingId}
      variant="plain"
    >
      {run === "idle" ? (
        <form className="flex min-w-0 flex-col gap-3" onSubmit={submit}>
          <label className="text-sm font-medium" htmlFor={`${headingId}-count`}>
            Count
          </label>
          <Input
            id={`${headingId}-count`}
            inputMode="numeric"
            onChange={(event) => setField("count", event.target.value)}
            value={form.count}
          />
          <label className="text-sm font-medium" htmlFor={`${headingId}-minutes`}>
            Time limit (minutes)
          </label>
          <Input
            id={`${headingId}-minutes`}
            inputMode="numeric"
            onChange={(event) => setField("minutes", event.target.value)}
            value={form.minutes}
          />
          <label className="text-sm font-medium" htmlFor={`${headingId}-command`}>
            Condition command (optional)
          </label>
          <Input
            id={`${headingId}-command`}
            onChange={(event) => setField("command", event.target.value)}
            value={form.command}
          />
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="font-medium">When the command runs</legend>
            {MODE_OPTIONS.map((option) => (
              <label className="flex items-center gap-2" key={option.value}>
                <input
                  checked={form.mode === option.value}
                  name={`${headingId}-mode`}
                  onChange={() => setField("mode", option.value)}
                  type="radio"
                  value={option.value}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          {formError ? <InlineError message={formError} /> : null}
          <Toolbar ariaLabel="Loop actions">
            <Button type="submit">Start loop</Button>
          </Toolbar>
        </form>
      ) : (
        <Toolbar ariaLabel="Loop actions">
          {run === "running" ? (
            <Button ref={firstActionRef} onClick={onPause} type="button" variant="outline">
              Pause loop
            </Button>
          ) : (
            <Button ref={firstActionRef} onClick={onResume} type="button" variant="outline">
              Resume loop
            </Button>
          )}
          <Button onClick={onStop} type="button" variant="destructive">
            Stop loop
          </Button>
        </Toolbar>
      )}
    </Section>
  );
}

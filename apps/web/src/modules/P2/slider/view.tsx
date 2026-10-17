import { useId } from "react";
import { InlineError } from "@/components/blocks";
import type { EffortLevel, ModelCatalogPort } from "@/modules/D1/contract";
import { executionTierModel } from "./model";

export interface ExecutionTierSliderProps {
  readonly catalog: ModelCatalogPort;
  readonly value: EffortLevel;
  readonly onChange: (tier: EffortLevel) => void | Promise<void>;
  readonly error?: string | null;
}

export function ExecutionTierSlider({
  catalog,
  value,
  onChange,
  error = null,
}: ExecutionTierSliderProps) {
  const id = useId();
  const model = executionTierModel(catalog);
  if (model === null) return null;
  const index = model.options.findIndex((option) => option.value === value);
  const selected = model.options[index];
  return (
    <div className="flex min-w-48 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium" htmlFor={id}>
          Execution tier
        </label>
        <span className="text-muted-foreground text-xs">{selected?.label ?? "Unavailable"}</span>
      </div>
      {selected === undefined && (
        <InlineError message="This model does not offer that level." variant="message" />
      )}
      <input
        aria-valuetext={selected?.label ?? "Unavailable"}
        disabled={selected === undefined}
        id={id}
        max={Math.max(model.options.length - 1, 0)}
        min={0}
        onChange={(event) => {
          const option = model.options[Number(event.target.value)];
          if (option !== undefined) void onChange(option.value);
        }}
        type="range"
        value={Math.max(index, 0)}
      />
      <div aria-hidden="true" className="text-muted-foreground flex justify-between text-[0.7rem]">
        {model.options.map((option) => (
          <span key={option.value}>{option.label}</span>
        ))}
      </div>
      {error && <InlineError message={error} variant="message" />}
    </div>
  );
}

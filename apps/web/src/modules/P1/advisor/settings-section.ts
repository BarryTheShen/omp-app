import type { JsonValue } from "@omp-app/contracts";
import type {
  ScalarSettingControl,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "@/modules/S1/settings-kit";
import { ADVISOR_SETTING_DEFINITIONS, type AdvisorSettingDefinition } from "./model";

const VALID: ValidationResult = { valid: true };

function plain(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

/**
 * The value domain omp checks for each advisor setting (omp v18.12.6 `packages/coding-agent/src/advisor/config.ts:49-70`
 * and `:236-242`): a choice from the list, a whole number of 1 or more for the review interval, a number of 1 or more
 * for the notes per update, and true or false for a switch.
 */
function validatorFor(definition: AdvisorSettingDefinition): ScalarSettingControl["validate"] {
  if (definition.kind === "boolean") {
    return (value) =>
      typeof plain(value) === "boolean"
        ? VALID
        : { valid: false, code: "boolean", message: "Choose on or off." };
  }
  if (definition.kind === "select") {
    const values = (optionsFor(definition) ?? []).map((option) => option.value);
    return (value) =>
      values.includes(plain(value) ?? null)
        ? VALID
        : { valid: false, code: "choice", message: "Choose one of the available options." };
  }
  const whole = definition.key === "advisor.reviewInterval";
  return (value) => {
    const number = plain(value);
    const fits =
      typeof number === "number" &&
      Number.isFinite(number) &&
      number >= 1 &&
      (!whole || Number.isInteger(number));
    return fits
      ? VALID
      : {
          valid: false,
          code: "number",
          message: whole ? "Enter a whole number, 1 or more." : "Enter a number, 1 or more.",
        };
  };
}

/** The choices as omp stores them: numbers for a number setting offered as a list (Immune Turns), text otherwise. */
function optionsFor(definition: AdvisorSettingDefinition): ScalarSettingControl["options"] {
  if (definition.options === undefined) return undefined;
  const numeric = typeof definition.defaultValue === "number";
  return definition.options.map((option) => ({
    value: numeric ? Number(option.value) : option.value,
    label: option.label,
  }));
}

function controlFor(definition: AdvisorSettingDefinition): ScalarSettingControl {
  const options = optionsFor(definition);
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    kind:
      definition.kind === "boolean" ? "boolean" : definition.kind === "select" ? "enum" : "number",
    secret: false,
    // omp reads the advisor's settings when a review is scheduled and when a note arrives (`advisor.ts`, header).
    apply: "live",
    validate: validatorFor(definition),
    ...(options === undefined ? {} : { options }),
  };
}

/**
 * omp's `model/Advisor` settings section (P1 owns it: `packages/contracts/src/core/modules.ts`, the `model/Advisor`
 * decision), built from the advisor's setting definitions so the Settings screen shows the same eight settings omp's
 * own settings screen does. Writes go through A1's ConfigStore, as every other section's do.
 */
export const ADVISOR_SETTINGS_SECTION: SettingsSectionDescriptor = {
  id: "P1.modelAdvisor",
  section: "model/Advisor",
  title: "Advisor",
  inventory: ["S2.model-advisor"],
  requires: ["host.config"],
  controls: ADVISOR_SETTING_DEFINITIONS.map(controlFor),
};

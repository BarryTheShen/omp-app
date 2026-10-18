import type { FolderPath, JsonValue, ThreadId } from "@omp-app/contracts";
import { AppFailure, UiRequestId } from "@omp-app/contracts";
import type { DialogHost, DialogHostOpenOptions } from "@/modules/U4/contract";
import type { AdvisorConfigController, AdvisorConfigLayer, AdvisorKey } from "./advisor";
import { ADVISOR_SETTING_DEFINITIONS, type AdvisorSettingDefinition } from "./model";

const CLOSE = "Close";
const PROJECT = "Project settings";
const GLOBAL = "Global settings";
let requestSequence = 0;

function requestId(purpose: string) {
  requestSequence += 1;
  return UiRequestId.parse(`app-p1-advisor-${purpose}-${requestSequence}`);
}

function optionsFor(definition: AdvisorSettingDefinition): readonly string[] {
  return definition.options?.map((option) => option.label) ?? [];
}

function valueFor(definition: AdvisorSettingDefinition, label: string): JsonValue {
  if (definition.kind === "boolean") return label === "On";
  if (definition.kind === "number") {
    const value = Number(label);
    if (!Number.isInteger(value) || value < 1) {
      throw new AppFailure({
        code: "invalid_args",
        message: "Enter a whole number above zero.",
        retryable: false,
      });
    }
    return value;
  }
  const option = definition.options?.find((candidate) => candidate.label === label);
  if (!option) {
    throw new AppFailure({
      code: "invalid_args",
      message: "Choose one of the listed advisor settings.",
      retryable: false,
    });
  }
  if (definition.key === "advisor.immuneTurns" || definition.key === "advisor.reviewInterval")
    return Number(option.value);
  return option.value;
}

function dialogOptions(threadId: ThreadId, signal?: AbortSignal): DialogHostOpenOptions {
  return { threadId, origin: "app", signal };
}

async function choose(
  dialogs: DialogHost,
  threadId: ThreadId,
  title: string,
  options: readonly string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await dialogs.open(
    { kind: "select", id: requestId("select"), title, options: [...options] },
    dialogOptions(threadId, signal),
  );
  if (result.outcome !== "answered" || result.response.kind !== "select") return null;
  return result.response.value;
}

async function chooseValue(
  dialogs: DialogHost,
  threadId: ThreadId,
  definition: AdvisorSettingDefinition,
  signal?: AbortSignal,
): Promise<string | null> {
  if (definition.kind === "number") {
    const result = await dialogs.open(
      {
        kind: "input",
        id: requestId("number"),
        title: definition.label,
        placeholder: "Whole number above zero",
      },
      dialogOptions(threadId, signal),
    );
    return result.outcome === "answered" && result.response.kind === "input"
      ? result.response.value
      : null;
  }
  const options = definition.kind === "boolean" ? ["On", "Off"] : optionsFor(definition);
  return choose(dialogs, threadId, definition.label, [...options, "Cancel"], signal);
}

/**
 * Opens advisor configuration through U4's app-origin DialogHost. omp's configure subcommand is
 * terminal-only at v18.9.1, so this wizard edits the same settings through A1's typed store instead
 * of pretending the RPC command opened a browser editor.
 */
export async function openAdvisorConfiguration(options: {
  readonly dialogs: DialogHost;
  readonly controllerForLayer: (layer: AdvisorConfigLayer) => AdvisorConfigController;
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const layerChoice = await choose(
    options.dialogs,
    options.threadId,
    "Where should advisor settings be saved?",
    [GLOBAL, ...(options.folder ? [PROJECT] : []), CLOSE],
    options.signal,
  );
  if (layerChoice === null || layerChoice === CLOSE) return;
  const layer: AdvisorConfigLayer = layerChoice === PROJECT ? "project" : "global";
  const controller = options.controllerForLayer(layer);
  await controller.read();

  while (true) {
    const settingLabels = ADVISOR_SETTING_DEFINITIONS.map((definition) => definition.label);
    const settingChoice = await choose(
      options.dialogs,
      options.threadId,
      "Choose an advisor setting",
      [...settingLabels, CLOSE],
      options.signal,
    );
    if (settingChoice === null || settingChoice === CLOSE) return;
    const definition = ADVISOR_SETTING_DEFINITIONS.find(
      (candidate) => candidate.label === settingChoice,
    );
    if (!definition) continue;
    let selectedValue: JsonValue | undefined;
    while (selectedValue === undefined) {
      const valueChoice = await chooseValue(
        options.dialogs,
        options.threadId,
        definition,
        options.signal,
      );
      if (valueChoice === null || valueChoice === "Cancel") break;
      try {
        selectedValue = valueFor(definition, valueChoice);
      } catch (error) {
        if (!(error instanceof AppFailure) || error.appError.code !== "invalid_args") throw error;
        await options.dialogs.confirm(
          {
            kind: "confirm",
            id: requestId("invalid-value"),
            title: "That number is not valid",
            message: "Enter a whole number above zero and try again.",
          },
          dialogOptions(options.threadId, options.signal),
        );
      }
    }
    if (selectedValue === undefined) continue;

    try {
      await controller.write(definition.key as AdvisorKey, selectedValue);
    } catch (error) {
      if (!(error instanceof AppFailure) || error.appError.code !== "conflict") throw error;
      const retry = await options.dialogs.confirm(
        {
          kind: "confirm",
          id: requestId("conflict"),
          title: "These settings changed elsewhere",
          message: "Reload the latest advisor settings before saving this choice again?",
        },
        dialogOptions(options.threadId, options.signal),
      );
      if (retry) {
        await controller.read();
        await controller.write(definition.key as AdvisorKey, selectedValue);
      }
    }
  }
}

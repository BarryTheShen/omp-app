import type { CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { capabilityStatus, UPSTREAM_UNAVAILABLE } from "@/registry-core";
import type { PromptDelivery, PromptIntent, PromptMode } from "../contract";

export interface ParsedModeInput {
  readonly mode: PromptMode;
  readonly text: string;
  readonly excludeFromContext?: boolean;
}

/** The released prompt wire has no exclude flag; U2 carries this app intent extension to the host seam. */
export type BashPromptIntent = PromptIntent & { readonly excludeFromContext?: boolean };

export type ModeExitKey = "Escape" | "Backspace" | string;

export interface PythonModeAvailability {
  readonly available: boolean;
  readonly reason: string;
}

function hasWhitespaceAfterSigil(text: string, sigilLength: number): boolean {
  const next = text[sigilLength];
  return next === " " || next === "\t" || next === "\n" || next === "\r";
}

/** Parses terminal-compatible !/!! and $/$$ prefixes without treating $HOME as Python. */
export function parseComposerMode(text: string): ParsedModeInput {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("!!")) {
    return { mode: "bash", text: trimmed.slice(2).trimStart(), excludeFromContext: true };
  }
  if (trimmed.startsWith("!") && !trimmed.startsWith("!!")) {
    return { mode: "bash", text: trimmed.slice(1).trimStart() };
  }
  if (trimmed.startsWith("$$") && hasWhitespaceAfterSigil(trimmed, 2)) {
    return { mode: "python", text: trimmed.slice(2).trimStart(), excludeFromContext: true };
  }
  if (trimmed.startsWith("$") && hasWhitespaceAfterSigil(trimmed, 1)) {
    return { mode: "python", text: trimmed.slice(1).trimStart() };
  }
  return { mode: "prompt", text };
}
/** The indicator's source of truth: derive mode directly from current composer text. */
export function modeForText(text: string): PromptMode {
  return parseComposerMode(text).mode;
}

/** The composer text an intent came from, mode prefix included, so a draft keeps what was typed. */
export function composerTextForIntent(intent: PromptIntent): string {
  const excluded = intent.excludeFromContext === true;
  switch (intent.mode) {
    case "prompt":
      return intent.text;
    case "bash":
      return `${excluded ? "!!" : "!"}${intent.text}`;
    case "python":
      return `${excluded ? "$$ " : "$ "}${intent.text}`;
  }
}

/**
 * Adds/removes terminal mode prefixes without keeping a second mode state. The text already in the mode that is
 * asked for is returned as typed, so a `!!` or `$$` marker survives a click on the mode that is already on.
 */
export function textForMode(text: string, mode: PromptMode): string {
  const parsed = parseComposerMode(text);
  if (parsed.mode === mode) return text;
  const body = parsed.mode === "prompt" ? text : parsed.text;
  switch (mode) {
    case "prompt":
      return body;
    case "bash":
      return `!${body}`;
    case "python":
      return `$ ${body}`;
  }
}

export function shouldExitMode(mode: PromptMode, key: ModeExitKey, text: string): boolean {
  if (mode === "prompt") return false;
  return key === "Escape" || (key === "Backspace" && text.length === 0);
}

export function pythonModeAvailability(capabilities: CapabilityMap): PythonModeAvailability {
  const status = capabilityStatus(capabilities, "upstream.python-mode");
  if (status?.state === "available") return { available: true, reason: "" };
  if (status === UPSTREAM_UNAVAILABLE) {
    return { available: false, reason: "Python mode is not available in this version of omp." };
  }
  return {
    available: false,
    reason: status?.detail ?? "Python mode is not available in this version of omp.",
  };
}

export async function submitModeInput(
  input: ParsedModeInput,
  delivery: PromptDelivery,
  capabilities: CapabilityMap,
  submitPrompt: (intent: PromptIntent) => Promise<void>,
): Promise<void> {
  if (input.mode === "python" && !pythonModeAvailability(capabilities).available) {
    throw new AppFailure({
      code: "unavailable",
      message: pythonModeAvailability(capabilities).reason,
      retryable: false,
      capability: "upstream.python-mode",
    });
  }
  const intent: BashPromptIntent = {
    mode: input.mode,
    text: input.text,
    delivery,
    ...(input.excludeFromContext === undefined
      ? {}
      : { excludeFromContext: input.excludeFromContext }),
  };
  await submitPrompt(intent);
}

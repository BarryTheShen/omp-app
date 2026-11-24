import type { SettingDef } from "../settings/data";

/**
 * The AI round of the setup: omp interviews the person in a chat and ends with the settings it proposes, as one fenced
 * block in the language `PROPOSAL_LANGUAGE` holding a JSON list of `{ key, value, why }`. The transcript shows the block
 * with **Review these settings**, which opens the setup's own plan of changes: nothing is written before Apply.
 */
export const PROPOSAL_LANGUAGE = "omp-app-setup";

export type ProposedValue = string | number | boolean;

export interface Proposed {
  readonly key: string;
  readonly value: ProposedValue;
  readonly why: string;
}

/** The omp settings a chat may propose: ones the app's chats read, not secrets, of a simple type. */
export function proposable(defs: readonly SettingDef[]): readonly SettingDef[] {
  return defs.filter(
    (def) =>
      def.secret !== true &&
      def.terminalOnly !== true &&
      (def.type === "boolean" ||
        def.type === "enum" ||
        def.type === "number" ||
        def.type === "string"),
  );
}

/** Whether `value` is one `def` takes: its type, and one of its values or choices when it lists them. */
function fits(def: SettingDef, value: unknown): value is ProposedValue {
  switch (def.type) {
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (def.values ?? []).includes(value);
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (def.choices === undefined || def.choices.some((choice) => Number(choice.value) === value))
      );
    case "string":
      return typeof value === "string" && value.length <= 500;
    default:
      return false;
  }
}

/**
 * The block's proposals that name a setting a chat may propose with a value it takes; the rest are left out, each with
 * why, so the plan can say so. Unreadable JSON proposes nothing.
 */
export function readProposal(
  text: string,
  defs: readonly SettingDef[],
): { readonly proposed: readonly Proposed[]; readonly left: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { proposed: [], left: ["The proposal is not readable JSON."] };
  }
  if (!Array.isArray(parsed)) return { proposed: [], left: ["The proposal is not a list."] };
  const byKey = new Map(proposable(defs).map((def) => [def.key, def]));
  const proposed: Proposed[] = [];
  const left: string[] = [];
  for (const item of parsed.slice(0, 40)) {
    const { key, value, why } = (item ?? {}) as { key?: unknown; value?: unknown; why?: unknown };
    const def = typeof key === "string" ? byKey.get(key) : undefined;
    if (def === undefined) left.push(`${String(key)}: not a setting the setup changes.`);
    else if (!fits(def, value))
      left.push(`${def.key}: ${JSON.stringify(value)} is not a value it takes.`);
    else if (!proposed.some((each) => each.key === def.key))
      proposed.push({ key: def.key, value, why: typeof why === "string" ? why.slice(0, 200) : "" });
  }
  return { proposed, left };
}

/** One line of the interview's list of settings: key, type, values or choices, and what it does. */
function line(def: SettingDef): string {
  const takes =
    def.type === "enum"
      ? (def.values ?? []).join(" | ")
      : def.type === "number" && def.choices !== undefined
        ? def.choices.map((choice) => choice.value).join(" | ")
        : def.type;
  const description = def.description.replace(/\s+/g, " ").slice(0, 140);
  return `- ${def.key} (${takes}): ${def.label}. ${description}`;
}

/** The interview's first message: what to ask, the settings it may propose, and the form of the proposal. */
export function interviewPrompt(defs: readonly SettingDef[]): string {
  const tabs = new Set(["model", "interaction", "context", "tasks", "tools"]);
  const listed = proposable(defs).filter((def) => tabs.has(def.tab));
  return [
    "Help me fine-tune omp for how I work. Ask me a few short questions with ask_async (at most 6, a few at a time, with choices), about the work I do with omp and how I like it to behave. Do not change any setting yourself.",
    `When you have my answers, reply with one fenced code block in the language ${PROPOSAL_LANGUAGE}: a JSON list of the settings you propose, each {"key": "<setting>", "value": <value>, "why": "<one short reason>"}, only from the list below and only with a value it takes. Propose only what my answers call for (at most 10). Before the block, say in two or three sentences what you propose and why; I review the changes in the app before anything changes.`,
    "Settings you may propose:",
    ...listed.map(line),
  ].join("\n\n");
}

import { STYLES } from "../theme/style";
import type { Answers } from "./plan";

/** One choice of a question: the value it gives its answer, its words, and a line more. */
export interface SetupOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

/** One card of the setup: which answer it fills, its words and its choices. Every card can be skipped. */
export interface SetupQuestion {
  readonly id: keyof Answers;
  readonly title: string;
  readonly detail?: string;
  /** Several may be picked. */
  readonly multi?: boolean;
  readonly options: readonly SetupOption[];
}

/** The questions, in the order asked: what omp is for first, as it picks the starting point for the rest. */
export const QUESTIONS: readonly SetupQuestion[] = [
  {
    id: "uses",
    title: "What will you mostly use omp for?",
    detail: "Pick all that fit. This picks a starting point; the next questions adjust it.",
    multi: true,
    options: [
      {
        value: "coding",
        label: "Coding in a project",
        detail: "omp thinks hard and asks before changing files",
      },
      {
        value: "writing",
        label: "Research and writing",
        detail: "Balanced thinking; asks before changing files",
      },
      {
        value: "study",
        label: "Study and notes",
        detail: "Asks before every action, so you see each step",
      },
      {
        value: "parallel",
        label: "Running many agents at once",
        detail: "Suggests splitting work; waits out usage limits",
      },
      { value: "trying", label: "Just trying it out", detail: "omp's own defaults" },
    ],
  },
  {
    id: "devices",
    title: "Where will you use it?",
    detail: "Pick all that fit.",
    multi: true,
    options: [
      { value: "computer", label: "This computer" },
      { value: "phone", label: "A phone" },
      { value: "tablet", label: "A tablet" },
      { value: "other-computer", label: "Another computer" },
    ],
  },
  {
    id: "away",
    title: "While a chat works, do you…",
    options: [
      { value: "false", label: "Watch it work" },
      {
        value: "true",
        label: "Leave it and come back",
        detail: "Notifications tell you when it needs you",
      },
    ],
  },
  {
    id: "notify",
    title: "Notify you when a chat needs you or a reply ends?",
    detail: "On this device; the setup turns them on and sends a test.",
    options: [
      { value: "true", label: "Yes, on this device" },
      { value: "false", label: "Not now" },
    ],
  },
  {
    id: "themeMode",
    title: "Light or dark?",
    options: [
      { value: "system", label: "Match the system" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  },
  {
    id: "style",
    title: "How should the app be drawn?",
    detail: "Any style goes with light or dark. You can change it later in Settings → App.",
    options: STYLES.map((style) => ({ value: style.id, label: style.name, detail: style.words })),
  },
  {
    id: "groupTools",
    title: "When omp makes several tool calls in a row…",
    options: [
      { value: "true", label: "Show them as one line", detail: "Click it to see each call" },
      { value: "false", label: "Show every call" },
    ],
  },
  {
    id: "closeAfter",
    title: "Workspaces you have not looked at for a while…",
    detail: "A pinned workspace always stays.",
    options: [
      { value: "12", label: "Close after 12 hours" },
      { value: "24", label: "Close after a day" },
      { value: "never", label: "Keep them open" },
    ],
  },
  {
    id: "approval",
    title: "Before omp changes files or runs commands, should it ask you?",
    options: [
      { value: "always-ask", label: "Ask before every action" },
      { value: "write", label: "Ask before changing files" },
      { value: "yolo", label: "Just work", detail: "omp's default" },
    ],
  },
  {
    id: "waitForReset",
    title: "When your model's usage limit is reached…",
    options: [
      { value: "true", label: "Wait for it to reset, then go on" },
      { value: "false", label: "Stop and tell me", detail: "omp's default" },
    ],
  },
];

/** The answer a card's picks give: lists for several, true/false, hours or null, or the value as it is. */
export function answerOf(
  question: SetupQuestion,
  picked: readonly string[],
): Answers[keyof Answers] {
  if (question.multi) return picked as never;
  const [one] = picked;
  if (one === undefined) return undefined;
  if (one === "true" || one === "false") return one === "true";
  if (question.id === "closeAfter") return one === "never" ? null : Number(one);
  return one as never;
}

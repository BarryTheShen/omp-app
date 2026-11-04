import * as path from "node:path";

type Message = { role: string; content?: unknown };
type Request = {
  messages?: Message[];
  stream?: boolean;
  /** The tools the request offers (chat completions: `{ type, function: { name } }`). */
  tools?: readonly { function?: { name?: string }; name?: string }[];
};
/** One tool call an assistant message makes. */
type ToolCall = { tool: string; args: Record<string, unknown>; id?: string };
type Reply =
  | { text: string; thinking?: string; streamed?: boolean; streamFailure?: string }
  | (ToolCall & { thinking?: string })
  | { tools: readonly ToolCall[]; thinking?: string }
  | { failure: string }
  /** A retryable provider error for the retry-notice e2e. */
  | { retryableFailure: string }
  /** `auth_probe` makes the provider refuse the key with HTTP 401, as a real provider does for a bad key. */
  | { unauthorized: string };

/** The calls a tool reply makes: one call, or several in one assistant message. */
function toolCallsOf(
  value: Exclude<
    Reply,
    { text: string } | { failure: string } | { retryableFailure: string } | { unauthorized: string }
  >,
): readonly ToolCall[] {
  return "tools" in value ? value.tools : [value];
}

/** `long_loop` makes the model run this many bash steps in one turn before it answers. */
const LOOP_STEPS = 60;
const LONG_PROVIDER_ERROR = "The fake provider rejected this request. ".repeat(60);
/** `plan_propose`'s plan: its slug names the file (`local://fix-the-login-plan.md`) and is what it submits. */
const PLAN_SLUG = "fix-the-login";
const PLAN_TEXT = "# Fix the login\n\n1. Read the login form.\n2. Fix the password check.\n";

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

/** `spawn_steerable_subagent` starts a worker whose task says `nested_steer_child`. That worker keeps taking
 * one-second bash steps until a message that starts with `steer_probe:` reaches it, then yields. The task text
 * itself never contains `steer_probe:`, so a repeated task message cannot count as the steer. It gives up after
 * STEER_WAIT_STEPS steps on its own, so a run that never steers cannot hang the server. */
const STEER_WAIT_STEPS = 90;

/** Whether omp offered this request its `yield` tool. A task subagent has none by default: `task.structured` is off
 * from omp 18.10.2 on (task/settings.ts:255-258, task/index.ts:781-782), so its final message is its result. */
function offersYield(request: Request): boolean {
  return (request.tools ?? []).some((tool) => (tool.function?.name ?? tool.name) === "yield");
}

/** A subagent's result: a `yield` call when the request offers the tool, else the final message as plain text. */
function finishSubagent(
  offers: boolean,
  summary: string,
  id: string | undefined,
  thinking: string,
): Reply {
  if (!offers) return { text: summary, thinking };
  return id === undefined
    ? { tool: "yield", args: { data: { summary } }, thinking }
    : { tool: "yield", args: { data: { summary } }, id, thinking };
}

function steerChildReply(messages: readonly Message[], offers: boolean): Reply | undefined {
  const start = messages.findIndex(
    (message) => message.role === "user" && text(message.content).includes("nested_steer_child"),
  );
  if (start < 0) return undefined;
  const after = messages.slice(start + 1);
  const steered = after.some(
    (message) => message.role === "user" && text(message.content).includes("steer_probe:"),
  );
  // Every yield gets an id of its own, as omp gives each call one. The default (`call_yield`) repeats, and a
  // transcript pairs a result with its call by id, so the later yields would read as unrecorded.
  if (steered)
    return finishSubagent(
      offers,
      "Steer received.",
      `call_yield_${messages.length}`,
      "The steer arrived, so I will submit.",
    );
  const steps = after.filter((message) => message.role === "tool").length;
  if (steps >= STEER_WAIT_STEPS)
    return finishSubagent(
      offers,
      "No steer arrived.",
      `call_yield_${messages.length}`,
      "No steer came in time.",
    );
  return {
    tool: "bash",
    args: { command: `sleep 1; echo steer-wait-${steps}` },
    id: `call_wait_${steps}`,
    thinking: "I am waiting for a steer.",
  };
}

/** `spawn_nested_probe` starts a worker whose task says `nested_parent_probe`. That worker starts one nested worker
 * (`nested_steer_child`, which keeps stepping until a steer arrives), then waits about 30 seconds in bash, so the
 * nested worker is still running while the probe steers or cancels it. */
function nestedParentReply(messages: readonly Message[]): Reply | undefined {
  const start = messages.findIndex(
    (message) => message.role === "user" && text(message.content).includes("nested_parent_probe"),
  );
  if (start < 0) return undefined;
  const steps = messages.slice(start + 1).filter((message) => message.role === "tool").length;
  if (steps === 0)
    return {
      tool: "task",
      args: {
        name: "NestedChild",
        agent: "task",
        task: "nested_steer_child: keep taking steps until a steer arrives from the parent, then yield.",
        solutionSpace: "one tiny task: wait for a steer and return a short summary",
      },
      id: `call_nested_child_${messages.length}`,
      thinking: "I should start one nested worker that waits for a steer.",
    };
  if (steps === 1)
    return {
      tool: "bash",
      args: { command: "sleep 30; echo nested-parent-waited" },
      id: `call_nested_wait_${messages.length}`,
      thinking: "I will wait while the nested worker runs.",
    };
  return { text: "Nested parent finished." };
}

/** How many characters one streamed piece carries, for a reply that is streamed in pieces. */
const STREAMED_PIECE_CHARACTERS = 12;
/** How long the server waits between two streamed pieces, short enough for several to coalesce. */
const STREAMED_PIECE_DELAY_MS = 40;
/** A fenced TypeScript block, streamed in pieces for the code-view e2e so the block grows while it is watched. */
const STREAMED_CODE_REPLY = [
  "Here is the streamed block:",
  "",
  "```typescript",
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (const value of values) {",
  "    total += value;",
  "  }",
  "  return total;",
  "}",
  "",
  "export const answer = sum([1, 2, 3]);",
  "```",
].join("\n");
/**
 * A fenced TypeScript block longer than the code view's short-block limit (2,048 characters), so it is coloured in the
 * background as it grows. The e2e spec builds the same rows (`apps/web/e2e/code-view-stream.spec.ts`).
 */
const STREAMED_LONG_CODE_REPLY = [
  "Here is the long streamed block:",
  "",
  "```typescript",
  ...Array.from(
    { length: 48 },
    (_, index) => `export const value${index}: number = ${index} * 2; // step ${index}`,
  ),
  "```",
].join("\n");

/**
 * A reply that streams for about a minute: 240 lines of about eighty-eight characters, sent in pieces. A spec that queues
 * messages during a reply needs the turn to stay open on a loaded machine, where the reply of `stream_long_code` is too
 * short for that.
 */
const STREAMED_STEADY_REPLY = Array.from(
  { length: 240 },
  (_, index) =>
    `Steady line ${index}: the reply keeps streaming while the queue waits, so the turn stays open.`,
).join("\n");

/**
 * A reply with math in every form a model writes: `$...$`, `$$...$$`, `\(...\)` and `\[...\]`, two prices in prose
 * (which stay text), and a code block (which stays code). The e2e spec `apps/web/e2e/fix-1167-math.spec.ts` counts on it.
 */
const STREAMED_MATH_REPLY = [
  "The total energy is $E = KE + V$, where $V$ is the potential energy.",
  "",
  "Inside the box the potential is zero, so $E_n = \\frac{n^2 h^2}{8 m L^2}$. The same idea in the other notation is \\(E_1 = \\frac{h^2}{8mL^2}\\).",
  "",
  "The wave function in display form:",
  "",
  "$$\\psi_n(x) = \\sqrt{\\tfrac{2}{L}}\\,\\sin\\!\\left(\\tfrac{n\\pi x}{L}\\right)$$",
  "",
  "The normalisation condition is:",
  "",
  "\\[\\int_0^L |\\psi_n|^2\\,dx = 1\\]",
  "",
  "which fixes the amplitude.",
  "",
  "It costs $5 and $10, which is plain text. Code stays code: `$x$`.",
  "",
  "```text",
  "$y = mx + b$",
  "```",
].join("\n");

/** The content of a reply, cut into pieces when the reply is streamed in pieces; otherwise one piece. */
function contentDeltas(content: string, inPieces: boolean): string[] {
  if (!inPieces) return [content];
  const pieces: string[] = [];
  for (let start = 0; start < content.length; start += STREAMED_PIECE_CHARACTERS) {
    pieces.push(content.slice(start, start + STREAMED_PIECE_CHARACTERS));
  }
  return pieces;
}

/** `count_reply` turns are counted across the whole fake server, so an answer given again is visibly new. */
let countedReplies = 0;

/** `usage_limit_after_job <tag>` (#2781): the tags whose job result's turn was refused once, as a usage limit does. */
const usageLimitRefused = new Set<string>();
/** `usage_limit_twice <tag>` (#2781): the refusals each tag has had, `start:<tag>` and `result:<tag>`. */
const usageTwiceRefused = new Set<string>();

/** How many background jobs a prompt starts: `run_background_pair` two, `run_background_job` one, else none. */
function backgroundJobCountOf(prompt: string): number {
  if (prompt.includes("run_background_pair")) return 2;
  if (prompt.includes("run_background_job")) return 1;
  return 0;
}

/** One bash call per job with `async`, so each starts a background job that outlives the turn. */
function backgroundStarts(count: number): Reply {
  const tools: ToolCall[] = Array.from({ length: count }, (_, index) => ({
    tool: "bash",
    args: { command: `sleep 120; echo job-${index}`, async: true },
    id: `call_background_${index}`,
  }));
  return { tools };
}

/**
 * `run_stale_background` and `run_stale_then_wait` start three jobs: one ends after four seconds, one runs for fifteen
 * minutes, and one ends after 25 seconds. A wait returns at the first job to end. `run_stale_then_wait` puts that wait in
 * the same turn as the starts, so it begins before the first job ends and its card lists all three jobs. The long job
 * outlasts the wait for the third job's notice, even on a loaded machine.
 */
function staleBackgroundStarts(): Reply {
  return {
    tools: [
      {
        tool: "bash",
        args: { command: "sleep 4; echo short-done", async: true },
        id: "call_stale_0",
      },
      {
        tool: "bash",
        args: { command: "sleep 900; echo long-job", async: true },
        id: "call_stale_1",
      },
      {
        tool: "bash",
        args: { command: "sleep 25; echo later-done", async: true },
        id: "call_stale_2",
      },
    ],
  };
}

/**
 * `stream_probe_child` takes one slow step, then streams one line of text and fails: its stream ends with an error
 * event, so omp's run fails and keeps the text it streamed. The step lets a wait card list the worker while it runs.
 */
function streamProbeReply(messages: readonly Message[]): Reply | undefined {
  const user = messages.findLastIndex((message) => message.role === "user");
  if (user < 0 || !text(messages[user]?.content).includes("stream_probe_child")) return undefined;
  const steps = messages.slice(user + 1).filter((message) => message.role === "tool").length;
  if (steps === 0)
    return {
      tool: "bash",
      args: { command: "sleep 15; echo warming-up" },
      thinking: "I should take one slow step first.",
    };
  return {
    text: "Partial answer before the stream failed.",
    streamed: true,
    streamFailure: "fake stream failure after the partial answer",
    thinking: "I will write one line, then the stream fails.",
  };
}

/**
 * `run_quick_background` starts one job that ends after two seconds, so its result is delivered while the chat is open.
 * `run_second_background` starts one long job with a call id of its own, for a second job in the same chat.
 * `usage_limit_after_job <tag>` starts a two-second job whose result's turn the provider refuses once (#2781).
 * `usage_limit_twice <tag>` starts a four-second job; the turn that started it is refused once with a wait of 61 s, then
 * the turn the job's result starts once with a wait of 5 s: a refusal after a refusal (#2781).
 * `usage_limit_job_running <tag>` starts a fifteen-minute job and a two-second one; the turn the short job's result
 * starts is refused once with a wait of 61 s while the long job runs on, so the session never settles (#2781, as the
 * chat that lost its continue on 2026-11-01 had a job running).
 */
function namedBackgroundStart(prompt: string): Reply | undefined {
  if (prompt.includes("run_quick_background"))
    return {
      tool: "bash",
      args: { command: "sleep 2; echo quick-done", async: true },
      id: "call_quick_background",
    };
  if (prompt.includes("run_second_background"))
    return {
      tool: "bash",
      args: { command: "sleep 120; echo second-job", async: true },
      id: "call_second_background",
    };
  const usageJob = /usage_limit_after_job (\w+)/.exec(prompt);
  if (usageJob?.[1] !== undefined)
    return {
      tool: "bash",
      args: { command: `sleep 2; echo usage-limit-job-done-${usageJob[1]}`, async: true },
      id: `call_usage_limit_${usageJob[1]}`,
    };
  const twiceJob = /usage_limit_twice (\w+)/.exec(prompt);
  if (twiceJob?.[1] !== undefined)
    return {
      tool: "bash",
      args: { command: `sleep 4; echo usage-limit-twice-done-${twiceJob[1]}`, async: true },
      id: `call_usage_twice_${twiceJob[1]}`,
    };
  const runningJob = /usage_limit_job_running (\w+)/.exec(prompt);
  if (runningJob?.[1] !== undefined)
    return {
      tools: [
        {
          tool: "bash",
          args: { command: `sleep 900; echo long-job-${runningJob[1]}`, async: true },
          id: `call_usage_running_long_${runningJob[1]}`,
        },
        {
          tool: "bash",
          args: { command: `sleep 2; echo usage-limit-running-done-${runningJob[1]}`, async: true },
          id: `call_usage_running_short_${runningJob[1]}`,
        },
      ],
    };
  return undefined;
}

/**
 * `read_pasted_reference local://paste-N.md` makes the model read that reference with omp's own `read` tool, once, and
 * `read_attached_file` the first `local://` reference anywhere in the message (a text file attached in the composer is
 * cited on a line of its own, #2658). The reply after the read is plain text, so the read's result is what the chat
 * holds for the file.
 */
function readPastedReferenceStart(prompt: string): Reply | undefined {
  const reference =
    /read_pasted_reference (local:\/\/paste-\d+\.md)/.exec(prompt)?.[1] ??
    (prompt.includes("read_attached_file") ? /(local:\/\/[\w.-]+)/.exec(prompt)?.[1] : undefined);
  if (reference === undefined) return undefined;
  return { tool: "read", args: { path: reference }, id: "call_read_pasted_reference" };
}

function reply(request: Request): Reply {
  const messages = request.messages ?? [];
  const steerChild = steerChildReply(messages, offersYield(request));
  if (steerChild !== undefined) return steerChild;
  const streamChild = streamProbeReply(messages);
  if (streamChild !== undefined) return streamChild;
  const nestedParent = nestedParentReply(messages);
  if (nestedParent !== undefined) return nestedParent;
  const last = messages.at(-1);
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  if (lastUser >= 0 && text(messages[lastUser]?.content).includes("long_loop")) {
    // One turn of many steps: a tool call per round, each with its own id, no thinking part.
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done < LOOP_STEPS)
      return { tool: "bash", args: { command: `echo loop-${done}` }, id: `call_loop_${done}` };
    return { text: "loop finished" };
  }
  // Plan mode (#768): the model writes its plan to `local://<slug>-plan.md`, then submits the slug to `xd://propose`, as
  // omp's plan prompt asks (`prompts/system/plan-mode-active.md` at 18.12.6). The run on the approved plan starts with
  // omp's synthetic developer message, not a user message, so it is not this script's.
  if (
    lastUser >= 0 &&
    text(messages[lastUser]?.content).includes("plan_propose") &&
    (last?.role === "user" || last?.role === "tool")
  ) {
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done === 0)
      return {
        tool: "write",
        args: { path: `local://${PLAN_SLUG}-plan.md`, content: PLAN_TEXT },
        id: "call_plan_write",
        thinking: "I should write the plan.",
      };
    if (done === 1)
      return {
        tool: "write",
        args: { path: "xd://propose", content: PLAN_SLUG },
        id: "call_plan_propose",
        thinking: "The plan is ready, so I submit it.",
      };
    return { text: "The plan is ready for review." };
  }
  // A write outside the plan file while planning: omp's plan-mode guard refuses it, and the reply quotes the refusal.
  if (
    lastUser >= 0 &&
    text(messages[lastUser]?.content).includes("plan_write_outside") &&
    last?.role === "user"
  )
    return {
      tool: "write",
      args: { path: "outside-the-plan.txt", content: "not allowed while planning\n" },
      id: "call_plan_outside",
    };
  const named = namedBackgroundStart(text(messages[lastUser]?.content));
  if (named !== undefined) {
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done === 0) return named;
    const twice = /usage_limit_twice (\w+)/.exec(text(messages[lastUser]?.content))?.[1];
    if (twice !== undefined && !usageTwiceRefused.has(`start:${twice}`)) {
      usageTwiceRefused.add(`start:${twice}`);
      return { failure: "The fake provider refused this request for now. retry-after-ms=61000" };
    }
    return { text: "background job started" };
  }
  // A worker the parent collects with `wait` (issue 2535): the task, then the wait that collects it, then a short answer.
  if (text(messages[lastUser]?.content).includes("spawn_wait_subagent")) {
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done === 0)
      return {
        tool: "task",
        args: {
          name: "WaitProbe",
          agent: "task",
          task: "wait_probe_child: return a short result by calling yield.",
          solutionSpace: "one tiny task: return a short summary",
        },
        thinking: "I should start one child task and collect it with wait.",
      };
    if (done === 1) return { tool: "wait", args: {}, thinking: "I should collect the worker." };
    return { text: "The worker is collected." };
  }
  if (text(messages[lastUser]?.content).includes("run_stale_then_wait")) {
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done === 0) return staleBackgroundStarts();
    // After the three starts, in the same turn: the wait covers all three jobs, not only those still running later.
    if (done === 3)
      return { tool: "wait", args: {}, thinking: "I should wait for the background jobs to end." };
    return { text: "background jobs started" };
  }
  if (text(messages[lastUser]?.content).includes("run_stale_background")) {
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done === 0) return staleBackgroundStarts();
    return { text: "background jobs started" };
  }
  // Background jobs: each bash call returns at once (`async`), so the turn ends while each job keeps running.
  const backgroundCount = backgroundJobCountOf(text(messages[lastUser]?.content));
  if (backgroundCount > 0) {
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done === 0) return backgroundStarts(backgroundCount);
    return { text: "background jobs started" };
  }
  const readReference = readPastedReferenceStart(text(messages[lastUser]?.content));
  if (readReference !== undefined) {
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done === 0) return readReference;
    return { text: "reference read" };
  }
  if (last?.role === "tool") return { text: `tool said: ${text(last.content)}` };
  const prompt = last?.role === "user" ? text(last.content) : "";
  // omp's request to name the chat (`title-fork.md`, #2798): one card title, as a model gives it.
  if (prompt.includes("<title-request>"))
    return { text: '<title emoji="🧪" code="FAKE">Fake chat title marker</title>' };
  // `context_has <word>`: whether any earlier message the model was sent holds <word>. A `!!` run (#839) is kept out of the
  // model's context, so its command and output must not reach it; a plain `!` run does.
  const contextProbe = /context_has\s+(\S+)/.exec(prompt);
  if (contextProbe?.[1] !== undefined) {
    const word = contextProbe[1];
    const seen = messages.slice(0, -1).some((message) => text(message.content).includes(word));
    return { text: `context ${seen ? "has" : "lacks"} ${word}` };
  }
  // `call_tool <name> <json arguments>`: one call of any tool the session offers (a host tool, `read` of a host URI),
  // then the usual "tool said" answer above.
  const toolProbe = /call_tool\s+(\S+)\s+(\{.*\})/.exec(prompt);
  if (toolProbe?.[1] !== undefined && toolProbe[2] !== undefined) {
    return { tool: toolProbe[1], args: JSON.parse(toolProbe[2]) as Record<string, unknown> };
  }
  // The turn a `usage_limit_after_job` result starts (#2781) is refused once, with the provider's wait in the error, and
  // answered after. A plain 400, so omp does not retry it itself: what continues the chat is the app.
  const usageLimitResult = /usage-limit-job-done-(\w+)/.exec(prompt);
  if (usageLimitResult?.[1] !== undefined) {
    if (!usageLimitRefused.has(usageLimitResult[1])) {
      usageLimitRefused.add(usageLimitResult[1]);
      return { failure: "The fake provider refused this request for now. retry-after-ms=61000" };
    }
    return { text: "Answered after the usage limit reset." };
  }
  const twiceResult = /usage-limit-twice-done-(\w+)/.exec(prompt);
  if (twiceResult?.[1] !== undefined) {
    if (!usageTwiceRefused.has(`result:${twiceResult[1]}`)) {
      usageTwiceRefused.add(`result:${twiceResult[1]}`);
      return { failure: "The fake provider refused this request for now. retry-after-ms=5000" };
    }
    return { text: "Answered after the usage limit reset." };
  }
  const runningResult = /usage-limit-running-done-(\w+)/.exec(prompt);
  if (runningResult?.[1] !== undefined) {
    if (!usageLimitRefused.has(`running:${runningResult[1]}`)) {
      usageLimitRefused.add(`running:${runningResult[1]}`);
      return { failure: "The fake provider refused this request for now. retry-after-ms=61000" };
    }
    return { text: "Answered after the usage limit reset." };
  }
  if (prompt.includes("retry_failure_probe"))
    return { retryableFailure: "fake provider retry failure" };
  if (prompt.includes("spawn_nested_probe"))
    return {
      tool: "task",
      args: {
        name: "NestedParent",
        agent: "task",
        task: "nested_parent_probe: start one nested worker and keep running for a while.",
        solutionSpace: "one nested worker: start it and wait for it",
      },
      id: `call_nested_parent_${messages.length}`,
      thinking: "I should start a worker that starts a nested worker.",
    };
  if (prompt.includes("spawn_steerable_subagent"))
    return {
      tool: "task",
      args: {
        name: "SteerProbe",
        agent: "task",
        task: "nested_steer_child: keep taking steps until a steer arrives from the parent, then yield.",
        solutionSpace: "one tiny task: wait for a steer and return a short summary",
      },
      thinking: "I should start a worker that waits for a steer.",
    };
  if (prompt.includes("spawn_subagent"))
    return {
      tool: "task",
      args: {
        name: "NestedProbe",
        agent: "task",
        task: "nested_probe_child: return a short result by calling yield.",
        solutionSpace: "one tiny task: return a short summary",
      },
      thinking: "I should start one child task.",
    };
  if (prompt.includes("wait_probe_child")) return { text: "Wait probe completed." };
  if (prompt.includes("nested_probe_child"))
    return finishSubagent(
      offersYield(request),
      "Nested probe completed.",
      undefined,
      "I should submit the result.",
    );
  if (prompt.includes("spawn_failing_subagent"))
    return {
      tool: "task",
      args: {
        name: "FailProbe",
        agent: "task",
        task: "fail_probe_child: fail on purpose so the hub shows a failed worker.",
        solutionSpace: "one tiny task: fail",
      },
      thinking: "I should start one child task that fails.",
    };
  if (prompt.includes("runtime_failure_long"))
    return {
      text: "A partial answer arrived before the provider failed.",
      streamed: true,
      streamFailure: LONG_PROVIDER_ERROR,
    };
  if (prompt.includes("provider_failure_long")) return { failure: LONG_PROVIDER_ERROR };
  if (prompt.includes("auth_probe_long"))
    return {
      unauthorized: `Invalid API key. ${LONG_PROVIDER_ERROR}`,
    };
  if (prompt.includes("auth_probe")) return { unauthorized: "Invalid API key" };
  if (prompt.includes("fail_probe_child"))
    return { failure: "fake provider failure for the failing subagent" };
  if (prompt.includes("spawn_stream_failing_subagent"))
    return {
      tool: "task",
      args: {
        name: "StreamProbe",
        agent: "task",
        task: "stream_probe_child: write one line of text, then the stream fails.",
        solutionSpace: "one line of text, then a stream failure",
      },
      thinking: "I should start one child task whose stream fails after its text.",
    };
  if (prompt.includes("spawn_quiet_subagent"))
    return {
      tool: "task",
      args: {
        name: "QuietProbe",
        agent: "task",
        task: "quiet_probe_child: answer in plain text and never call yield.",
        solutionSpace: "one tiny task: answer in plain text",
      },
      thinking: "I should start one child task that answers without yielding.",
    };
  if (prompt.includes("quiet_probe_child")) return { text: "Quiet probe answered in plain text." };
  if (prompt.includes("spawn_long_subagent"))
    return {
      tool: "task",
      args: {
        name: "LongProbe",
        agent: "task",
        task: "long_probe_child: run one slow step.",
        solutionSpace: "one slow step",
      },
      thinking: "I should start one slow child task.",
    };
  if (prompt.includes("long_probe_child"))
    return {
      tool: "bash",
      args: { command: "sleep 60; echo long-probe-done" },
      thinking: "I should run the slow step.",
    };
  // A subagent whose one bash call has an intent, for the task card's row (#2341). The seconds after each keyword say how
  // long the call sleeps (six by default): long enough for a spec to look at the running row, and no longer.
  if (prompt.includes("spawn_intent_subagent")) {
    const seconds = /\bspawn_intent_subagent\s+(\d+)\b/.exec(prompt)?.[1] ?? "6";
    return {
      tool: "task",
      args: {
        name: "IntentProbe",
        agent: "task",
        task: `intent_child ${seconds}: run one step with an intent.`,
        solutionSpace: "one step with an intent",
      },
      thinking: "I should start one child task that runs a command with an intent.",
    };
  }
  // The same child as `spawn_intent_subagent`, run inline: `fgprobe` declares `blocking: true`, so the parent waits (#2341).
  if (prompt.includes("spawn_foreground_intent")) {
    const seconds = /\bspawn_foreground_intent\s+(\d+)\b/.exec(prompt)?.[1] ?? "6";
    return {
      tool: "task",
      args: {
        name: "IntentProbe",
        agent: "fgprobe",
        task: `intent_child ${seconds}: run one step with an intent.`,
        solutionSpace: "one step with an intent",
      },
      thinking: "I should start one blocking child task that runs a command with an intent.",
    };
  }
  if (prompt.includes("intent_child")) {
    const seconds = /\bintent_child\s+(\d+)\b/.exec(prompt)?.[1] ?? "6";
    return {
      tool: "bash",
      args: {
        command: `sleep ${seconds}; echo intent-child-done`,
        i: "Waiting for the subagent's fixture command",
      },
      thinking: "I should run the step with an intent.",
    };
  }
  // The held version of the slow worker, for the specs that steer it: its command runs until the spec writes
  // release-long-probe into the agent folder (at most four minutes), so the spec's steps, not a clock, end it.
  if (prompt.includes("spawn_held_subagent"))
    return {
      tool: "task",
      args: {
        name: "LongProbe",
        agent: "task",
        task: "held_probe_child: run one slow step.",
        solutionSpace: "one slow step",
      },
      thinking: "I should start one held child task.",
    };
  if (prompt.includes("held_probe_child"))
    return {
      tool: "bash",
      args: {
        command: `for i in $(seq 1 480); do [ -f "${agentDir}/release-long-probe" ] && break; sleep 0.5; done; echo long-probe-done`,
      },
      thinking: "I should run the held slow step.",
    };
  if (prompt.includes("make_it_big")) return { text: "a".repeat(1_100_000) };
  // Forty paragraphs: the chat runs well past one screen, so the reader sits at its bottom (issue 1295).
  if (prompt.includes("long_reply_probe")) {
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index + 1} of a long reply.`,
    );
    return { text: paragraphs.join("\n\n") };
  }
  // One unbroken 306-character token, as a long URL or hash is: the reply must wrap it, not run past its box.
  if (prompt.includes("long_word_probe"))
    return { text: `Token: token-${"a1b2c3d4e5".repeat(30)} end of the token.` };
  if (prompt.includes("abort_slow")) return { text: "slow-stream", thinking: "working" };
  if (prompt.includes("stream_code")) return { text: STREAMED_CODE_REPLY, streamed: true };
  // A reply the spec holds open: it streams only after the spec writes release-held-reply into the agent folder.
  if (prompt.includes("stream_held")) return { text: STREAMED_LONG_CODE_REPLY, streamed: true };
  if (prompt.includes("stream_long_code"))
    return { text: STREAMED_LONG_CODE_REPLY, streamed: true };
  // Reasoning that streams for about fourteen seconds before its answer (issue #1330). Each sentence has its own
  // number: omp takes a stream that repeats one cycle again and again for a stall, and retries it. The reasoning
  // comes in pieces too, so the group stays running while the spec checks what the transcript shows.
  if (prompt.includes("stream_reasoning")) {
    const topics = ["latency", "cost", "memory", "risk", "clarity", "scope", "timing"];
    const sentences = Array.from(
      { length: 140 },
      (_, index) => `Weighing option ${index + 1} on ${topics[index % topics.length]}. `,
    );
    return {
      text: "The answer after the reasoning.",
      thinking: `reasoning-marker-7f3a ${sentences.join("")}`,
      streamed: true,
    };
  }
  if (prompt.includes("stream_steady")) return { text: STREAMED_STEADY_REPLY, streamed: true };
  // Multi-select questions (issue #1157): one checkbox question, and a single plus a checkbox question in one ask.
  if (prompt.includes("checkbox_ask_two"))
    return {
      tool: "ask",
      args: {
        questions: [
          {
            id: "db",
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
          {
            id: "tools",
            question: "Which tools should run?",
            options: [{ label: "Read" }, { label: "Grep" }, { label: "Bash" }],
            multi: true,
          },
        ],
      },
      thinking: "I need to ask two questions.",
    };
  if (prompt.includes("checkbox_ask_one"))
    return {
      tool: "ask",
      args: {
        questions: [
          {
            id: "tools",
            question: "Which tools should run?",
            options: [{ label: "Read" }, { label: "Grep" }, { label: "Bash" }],
            multi: true,
          },
        ],
      },
      thinking: "I need to ask which tools to run.",
    };
  if (prompt.includes("stream_math")) return { text: STREAMED_MATH_REPLY, streamed: true };
  if (prompt.includes("ask_user"))
    return {
      tool: "ask",
      args: {
        questions: [
          {
            id: "db",
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      },
      thinking: "I need to ask.",
    };
  if (prompt.includes("ask_recommended"))
    return {
      tool: "ask",
      args: {
        questions: [
          {
            id: "db",
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
            recommended: 1,
          },
        ],
      },
      thinking: "I need to ask, and SQLite is the one I recommend.",
    };
  // The question dialog (#2795): three questions with short headers, descriptions, a preview, one with several
  // answers, and a recommended answer where there is one.
  if (prompt.includes("ask_three"))
    return {
      tool: "ask",
      args: {
        questions: [
          {
            id: "db",
            header: "Database",
            question: "Which database?",
            options: [
              { label: "Postgres", description: "A server; best with many writers." },
              {
                label: "SQLite",
                description: "One file; nothing to run.",
                preview: 'preview-marker-3c9e: open("app.db")',
              },
            ],
            recommended: 1,
          },
          {
            id: "tools",
            header: "Tools",
            question: "Which tools should run?",
            options: [{ label: "Read" }, { label: "Grep" }, { label: "Bash" }],
            multi: true,
          },
          {
            id: "name",
            header: "Name",
            question: "What should the file be called?",
            options: [{ label: "notes.md" }, { label: "plan.md" }],
          },
        ],
      },
      thinking: "I need to ask three questions.",
    };
  // Issue #1327: one question whose text, one option label and one option description each hold a 100-character
  // word with no spaces. The ask dialog must wrap that word inside the dialog.
  if (prompt.includes("ask_long_word")) {
    const longWord =
      "some_very_long_snake_case_identifier_name_that_goes_on_and_on_and_on_for_quite_a_while_longer_or_not";
    return {
      tool: "ask",
      args: {
        questions: [
          {
            id: "db",
            question: `Which ${longWord} should omp use?`,
            options: [
              { label: "Postgres", description: longWord },
              { label: `SQLite ${longWord}` },
            ],
          },
        ],
      },
      thinking: "I need to ask, and the long word is in the question, a label and a description.",
    };
  }
  if (prompt.includes("make_todos"))
    return {
      tool: "todo",
      args: {
        op: "init",
        list: [{ phase: "Plan", items: ["Write the thing", "Test the thing"] }],
      },
      thinking: "I should track todos.",
    };
  // A bash call, then a write, in one message: write is exclusive, so omp starts it only after the bash.
  if (prompt.includes("run_queued_pair"))
    return {
      tools: [
        { tool: "bash", args: { command: "sleep 20; echo first" }, id: "call_queued_bash" },
        {
          tool: "write",
          args: { path: "queued-pair.txt", content: "second\n" },
          id: "call_queued_write",
        },
      ],
      thinking: "I should run bash, then write.",
    };
  // A task call and a 10 s bash call in one message: the worker (a 7 s bash of its own, from the slow_tool branch)
  // reports its end while this turn is still running, after the task call has already returned.
  if (prompt.includes("spawn_slow_with_sleep"))
    return {
      tools: [
        {
          tool: "task",
          args: {
            name: "SlowProbe",
            agent: "task",
            task: "slow_tool: run one slow step, then report.",
            solutionSpace: "one slow step",
          },
          id: "call_task_slow",
        },
        { tool: "bash", args: { command: "sleep 10; echo parent-slept" }, id: "call_parent_sleep" },
      ],
      thinking: "I should start one slow worker and wait for it.",
    };
  // The wait tool blocks on the chat's running background jobs, so its card lists them with their Stop controls (#1262).
  if (prompt.includes("wait_for_jobs"))
    return { tool: "wait", args: {}, thinking: "I should wait for the background jobs to end." };
  // A bash call that exits non-zero (issue #1324): omp's result ends with its wall-time and exit-code notes.
  if (prompt.includes("run_failing_bash"))
    return {
      tool: "bash",
      args: { command: "ls /nonexistent-omp-fixture" },
      thinking: "I should run a command that fails.",
    };
  if (prompt.includes("run_git_stash"))
    return {
      tool: "bash",
      args: { command: "git stash" },
      thinking: "I should try the requested Git stash command.",
    };
  // A bash call the model gives an intent (the `i` argument, omp's INTENT_FIELD), for the tool card's intent line (#2332).
  // It sleeps for the seconds after the keyword (six by default): long enough for a spec to look at the running card.
  if (prompt.includes("intent_probe")) {
    const seconds = /\bintent_probe\s+(\d+)\b/.exec(prompt)?.[1] ?? "6";
    return {
      tool: "bash",
      args: {
        command: `sleep ${seconds}; echo intent-probe-done`,
        i: "Waiting for the fixture command to finish",
      },
      thinking: "I should run a command and say what it is for.",
    };
  }
  // A service a chat starts (#2788): a small web server on a free port, in the background, for a minute at most. It
  // sends no type, as many small services do.
  if (prompt.includes("serve_probe"))
    return {
      tool: "bash",
      args: {
        command: `timeout 60 bun -e "require('node:http').createServer((q, s) => s.end('served-by-chat')).listen(0, '127.0.0.1')"`,
        async: true,
      },
      thinking: "I should start a server.",
    };
  if (prompt.includes("run_bash"))
    return { tool: "bash", args: { command: "echo fixture-tool" }, thinking: "I should run bash." };
  // A tool that prints its whole output and ends 0.1 s later, and one that prints and runs on for 2 s: a live-output box
  // shows only for the second (v2-tool-output).
  if (prompt.includes("burst_output_tool"))
    return {
      tool: "bash",
      args: { command: "sleep 1; seq 1 20; sleep 0.1" },
      thinking: "I should run it.",
    };
  if (prompt.includes("streaming_output_tool"))
    return {
      tool: "bash",
      args: { command: "seq 1 5; sleep 2; echo stream-done" },
      thinking: "I should run it.",
    };
  if (prompt.includes("read_long_probe"))
    return { tool: "read", args: { path: "long.txt" }, thinking: "I should read the long file." };
  if (prompt.includes("read_image"))
    return { tool: "read", args: { path: "pixel.png" }, thinking: "I should read the image." };
  if (prompt.includes("slow_tool")) {
    const seconds = /\bslow_tool\s+(\d+)\b/.exec(prompt)?.[1] ?? "7";
    return {
      tool: "bash",
      args: { command: `sleep ${seconds}; echo slow-tool-done` },
      thinking: "I should run something slow.",
    };
  }
  if (prompt.includes("count_reply")) {
    countedReplies += 1;
    // The word after the keyword names the turn; omp's own preamble in the prompt is not echoed.
    const word = /count_reply\s+(\S+)/.exec(prompt)?.[1] ?? "";
    return { text: `count-${countedReplies} ${word}`, thinking: "I will count this turn." };
  }
  // A reply with a markdown link and a bare URL, for the link-address spec (issue #825).
  if (prompt.includes("link_probe"))
    return {
      text: "A [link to example](https://example.com/page) and a bare https://example.org link. Check [example.com](https://evil.test/login) before you sign in.",
    };
  // A link to another host whose text is a host name of N characters, for the 390 px wrap spec (issue 944): where
  // the address starts on a 390 px line decides whether a line can break inside its scheme.
  if (prompt.includes("link_wrap_probe")) {
    const label = Number(/link_wrap_probe\s+(\d+)/.exec(prompt)?.[1] ?? 0);
    return {
      text: `Read this: [${"x".repeat(label)}.example.test](https://other.example.net/login/page/one) is the page to use.`,
    };
  }
  // Two tables (issue 2777): one with a column of short words beside a column of long sentences, as a decision table
  // is, and one with an address too long for any column, which makes the table wider than the chat.
  if (prompt.includes("table_probe"))
    return {
      text: [
        "| Area | Decision |",
        "| --- | --- |",
        "| Backups | Every hour, keeping 24 hourly, 14 daily and 8 weekly copies on the second disk, and later on the file server too; notes keep their own history every minute. |",
        "| Failover | You start the standby by hand and unlock it with a passphrase; a witness stops it from taking over while the main machine is still alive, and up to a minute of work may be lost. |",
        "| Security | A machine's access is never above the access of the machine that hosts it, so the host is guarded like the laptop is. |",
        "",
        "| Link | Note |",
        "| --- | --- |",
        `| https://example.com/${"a1b2c3d4e5".repeat(20)} | a long address |`,
      ].join("\n"),
    };
  return { text: "pong", thinking: "I will answer pong." };
}

const agentDir = process.argv[2];
if (agentDir === undefined) throw new Error("usage: fake-openai-server.ts <agentDir>");
// Next to the agent folder, not in it: omp watches its agent folder for settings changes, and a growing log there is noise to it.
const requestLog = Bun.file(path.join(path.dirname(agentDir), "requests.jsonl")).writer();
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
/**
 * The usage a reply reports. A latest user message holding `cache_warm` reads 800 tokens back from the prompt cache,
 * and one holding `cache_cold` writes 800 into it again. Both prompts are 1,100 tokens, so a cold turn reprocesses
 * 1,100: 300 new tokens and the 800 written (#1390).
 */
function usageOf(request: Request) {
  const messages = request.messages ?? [];
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const prompt = lastUser < 0 ? "" : text(messages[lastUser]?.content);
  if (prompt.includes("cache_cold"))
    return {
      prompt_tokens: 1_100,
      completion_tokens: 5,
      total_tokens: 1_105,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 800 },
    };
  if (prompt.includes("cache_warm"))
    return {
      prompt_tokens: 1_100,
      completion_tokens: 5,
      total_tokens: 1_105,
      prompt_tokens_details: { cached_tokens: 800 },
    };
  return usage;
}
/** A held reply streams this many lines before it waits for the spec's release (see holdForRelease). */
const HELD_AFTER_LINES = 8;
/** The text of the latest user message, so a keyword in an earlier message cannot hold or steer a later reply. */
function lastUserText(messages: readonly Message[] | undefined): string {
  const user = messages?.filter((message) => message.role === "user").at(-1);
  return user === undefined ? "" : text(user.content);
}

/** Keeps a held reply open with SSE comments until `file` exists, for at most four minutes. */
async function holdForRelease(
  controller: ReadableStreamDefaultController<string>,
  file: string,
): Promise<void> {
  for (let waited = 0; waited < 240_000 && !(await Bun.file(file).exists()); waited += 1000) {
    controller.enqueue(": held\n\n");
    await Bun.sleep(1000);
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models"))
      return Response.json({
        object: "list",
        data: [{ id: "fake-model", object: "model", owned_by: "fake" }],
      });
    if (!url.pathname.endsWith("/chat/completions"))
      return new Response("not found", { status: 404 });
    const body = (await request.json()) as Request;
    await requestLog.write(`${JSON.stringify(body)}\n`);
    await requestLog.flush();
    const value = reply(body);
    if ("unauthorized" in value)
      return Response.json(
        {
          error: {
            message: value.unauthorized,
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      );
    if ("retryableFailure" in value)
      return Response.json(
        {
          error: {
            message: value.retryableFailure,
            type: "server_error",
            code: "service_unavailable",
          },
        },
        { status: 503 },
      );
    if ("failure" in value)
      return Response.json(
        { error: { message: value.failure, type: "invalid_request_error" } },
        { status: 400 },
      );
    if (!body.stream)
      return Response.json({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: "fake-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "text" in value ? value.text : null },
            finish_reason: "text" in value ? "stop" : "tool_calls",
          },
        ],
        usage: usageOf(body),
      });
    const base = {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
    };
    // A reply flagged `streamed` (the `stream_code` and `stream_reasoning` keywords) is sent in pieces, its reasoning
    // too, a little apart.
    const streamFailure = "text" in value ? value.streamFailure : undefined;
    const inPieces = "text" in value && (value.streamed === true || streamFailure !== undefined);
    const chunks = [
      ...(value.thinking === undefined
        ? []
        : contentDeltas(value.thinking, inPieces).map((reasoning) => ({
            ...base,
            choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
          }))),
      ...("text" in value
        ? contentDeltas(value.text, inPieces).map((content) => ({
            ...base,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          }))
        : toolCallsOf(value).map((call, index) => ({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: call.id ?? `call_${call.tool}`,
                      type: "function",
                      function: { name: call.tool, arguments: JSON.stringify(call.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }))),
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "text" in value ? "stop" : "tool_calls" }],
      },
      { ...base, choices: [], usage: usageOf(body) },
    ];
    // A reply that fails after its text ends its stream with an error event, in place of the finish and the usage.
    const lines =
      streamFailure === undefined
        ? chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        : [
            ...chunks.slice(0, -2).map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
            `data: ${JSON.stringify({ error: { message: streamFailure, type: "invalid_request_error" } })}\n\n`,
          ];
    const stream =
      inPieces ||
      body.messages?.some(
        (message) => message.role === "user" && text(message.content).includes("abort_slow"),
      ) === true;
    if (stream) {
      const holdUntilReleased = lastUserText(body.messages).includes("stream_held");
      const bodyStream = new ReadableStream({
        async start(controller) {
          for (const [index, line] of lines.entries()) {
            // A held reply streams its first lines, then waits for the spec's release before the rest.
            if (holdUntilReleased && index === HELD_AFTER_LINES) {
              await holdForRelease(controller, path.join(agentDir, "release-held-reply"));
            }
            controller.enqueue(line);
            await Bun.sleep(inPieces ? STREAMED_PIECE_DELAY_MS : 100);
          }
          if (streamFailure === undefined) controller.enqueue("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(bodyStream, { headers: { "content-type": "text/event-stream" } });
    }
    const payload = `${lines.join("")}data: [DONE]\n\n`;
    return new Response(payload, { headers: { "content-type": "text/event-stream" } });
  },
});
const disabledProviders =
  process.env.FAKE_OPENAI_ENABLE_RULES === "1"
    ? ["agents-md", "agents", "claude", "codex", "gemini", "github", "opencode"]
    : ["agents-md", "agents", "native", "claude", "codex", "gemini", "github", "opencode"];
/**
 * A long catalog when a test asks for one (`FAKE_EXTRA_MODELS`, through the harness's `serverEnv`): a provider of that
 * many more models, as a real provider such as OpenRouter lists hundreds.
 */
const extraModels = Number(process.env.FAKE_EXTRA_MODELS ?? "0");
const manyModels: string[] = [];
if (extraModels > 0) {
  manyModels.push(
    "  many:",
    `    baseUrl: http://127.0.0.1:${server.port}/v1`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
  );
  for (let index = 1; index <= extraModels; index += 1)
    manyModels.push(
      `      - id: many-model-${index}`,
      `        name: Many Model ${index}`,
      "        contextWindow: 128000",
    );
  manyModels.push("");
}
await Bun.write(
  path.join(agentDir, "config.yml"),
  [
    "disabledProviders:",
    ...disabledProviders.map((provider) => `  - ${provider}`),
    "",
    "retry:",
    "  maxRetries: 3",
    "  baseDelayMs: 50",
    "",
  ].join("\n"),
);
await Bun.write(
  path.join(agentDir, "models.yml"),
  [
    "providers:",
    "  fake:",
    `    baseUrl: http://127.0.0.1:${server.port}/v1`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: fake-model",
    "        name: Fake Model",
    "        reasoning: true",
    // More models, one with a very long name and id, so layout tests see a list like a real one.
    "      - id: claude-3-5-sonnet-20240620",
    "        name: Claude Sonnet 3.5",
    "        contextWindow: 200000",
    "      - id: claude-3-haiku-20240307",
    "        name: Claude Haiku 3",
    "        contextWindow: 200000",
    "      - id: claude-fable-5",
    "        name: Claude Fable 5",
    "        reasoning: true",
    "        contextWindow: 1000000",
    "      - id: a-model-with-a-deliberately-long-identifier-for-layout-checks-20261007",
    "        name: A model with a deliberately long display name to check that rows are cut with an ellipsis, not clipped",
    "        reasoning: true",
    "        contextWindow: 128000",
    "      - id: fake-vision",
    "        name: Fake Vision",
    "        reasoning: true",
    "        input: [text, image]",
    "        contextWindow: 128000",
    "",
    ...manyModels,
  ].join("\n"),
);
console.log(`READY ${server.port}`);
for await (const _ of Bun.stdin.stream()) {
}
await requestLog.end();
server.stop(true);

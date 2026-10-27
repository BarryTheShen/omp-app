import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AppFailure,
  type CapabilityKey,
  CapabilityMap,
  INVENTORY,
  SubagentId,
  ThreadId,
  uncoveredInventory,
  validateRegistry,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  createSubagentClient,
  type SubagentClient,
  type SubagentSession,
} from "@/modules/P1/client";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import { P1_DESCRIPTORS } from "@/modules/P1/descriptors";
import {
  ADVISOR_ENABLED_WRITE,
  ADVISOR_ENABLED_WRITE_RESULT,
  ADVISOR_NOTE_AGE_CASES,
  ADVISOR_SECTION_KEYS,
  ADVISOR_STALE_WRITE_CONFLICT,
  advisorBatchMessage,
  FIXTURE_START,
  FOCUSED_TRANSCRIPT_PAGE,
  FOCUSED_TRANSCRIPT_ROLES,
  fixtureClock,
  fixtureRosterStore,
  HUB_STATE_FIXTURES,
  type HubStateSpec,
  hubStateInput,
  OMP_NOT_RUNNING_TEXT,
  P1_CAPABILITY_CASES,
  PROGRESS_JOIN_SCENARIOS,
  RETENTION_SCENARIOS,
  ROSTER_ORDERING_SCENARIOS,
  type RosterScenario,
  SUBAGENT_COMMAND_CASES,
  TRANSCRIPT_CURSOR_SCENARIOS,
  type WorkerExpectation,
} from "@/modules/P1/fixtures";
import { buildHubModel, CANCEL_REFUSED_MESSAGE, type HubModel } from "@/modules/P1/panels/model";
import type { RosterAgent } from "@/modules/P1/roster";
import {
  isHiddenTranscriptMessage,
  toReadonlyThreadMessages,
  toThreadMessages,
} from "@/modules/P1/transcript/messages";
import {
  EMPTY_STEER_DRAFT,
  steerFailureMessage,
  steerSendFailed,
} from "@/modules/P1/transcript/steer";
import {
  applyTranscriptPage,
  EMPTY_TRANSCRIPT_TAIL,
  requestOffset,
  type TranscriptTailState,
} from "@/modules/P1/transcript/tail";
import { OmpRuntimeStore, type OmpRuntimeTransport } from "@/modules/R0/store";
import { isDescriptorAvailable, isUsable } from "@/registry-core/hooks";

/**
 * The P1.6 gate: the Done-when evidence for the P1 module (modules/P1/README.md), run on the real P1 code and
 * the synthetic fixtures. It imports nothing from T5, so it proves P1 without T5's task card.
 *
 * Where the app differs from what omp documents, or from the shared gate, the check is a known-defect marker
 * (`test.fails`): it passes while the defect exists, names its issue, and fails once the defect is fixed, which
 * is the signal to remove the marker. CC4 (visual states) is proven here only as view-model states; the
 * screenshots and the visual review belong to the consistency-check agent.
 */

const T5_TASK_CARD = "P1.task-subagent-card";
const THREAD = ThreadId.parse("fixture-thread");
const WORKER = SubagentId.parse("worker-1");
/** Text a person must not read: a module or part id, a capability or config name, a raw id, or a code name. */
const INTERNAL_WORDS =
  /\bdescriptors?\b|\bcapabilit(?:y|ies)\b|\bConfigStore\b|\bRPC\b|\bCAS\b|\b[A-Z]\d{1,2}\b|\b(?:host|omp|upstream|client)\.[a-z]|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z][A-Za-z]*\b|\bOmp\b|\b(?:worker|agent|task|fixture)-[a-z0-9]+(?:-[a-z0-9]+)*\b/;
const FORBIDDEN_IMPORT =
  /(?:from\s+|import\(\s*|require\(\s*)["'][^"']*(?:modules\/T5\b|\.\.?\/T5\b|@omp-app\/server|omp-rpc|node:|@tauri-apps|electron)/;

/** Every P1 row the inventory assigns to P1: the P1 group less T5's task card, the advisor rows and the model advisor section. */
const P1_OWNED_ROWS: readonly string[] = INVENTORY.filter(
  (item) =>
    (item.group === "P1" && item.id !== T5_TASK_CARD) ||
    item.id.startsWith("C3.advisor") ||
    item.id === "S2.model-advisor",
).map((item) => item.id);

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("W5 / CC12: inventory coverage", () => {
  test("P1 covers every row it owns once, and leaves the task card to T5", () => {
    const covered: string[] = P1_DESCRIPTORS.flatMap((descriptor) => [...descriptor.covers]);

    expect(covered).toHaveLength(P1_OWNED_ROWS.length);
    expect(new Set(covered).size).toBe(covered.length);
    expect(sorted(covered)).toEqual(sorted(P1_OWNED_ROWS));
    expect(covered).not.toContain(T5_TASK_CARD);
  });

  test("no P1 row is uncovered by P1's own list, and the task card stays uncovered by P1", () => {
    const uncovered = new Set<string>(uncoveredInventory(P1_DESCRIPTORS));

    for (const row of P1_OWNED_ROWS) expect(uncovered.has(row)).toBe(false);
    expect(uncovered.has(T5_TASK_CARD)).toBe(true);
  });
});

describe("W5: registry and keyboard claims", () => {
  test("the P1 list passes C0 validation with no problems", () => {
    expect(validateRegistry(P1_DESCRIPTORS)).toEqual([]);
  });

  test("Alt+A and the double-left gesture are claimed by owner-prefixed descriptors", () => {
    const shortcut = P1_DESCRIPTORS.find((descriptor) => {
      const rows: readonly string[] = descriptor.covers;
      return rows.includes("P1.app-agents-hub");
    });
    const gesture = P1_DESCRIPTORS.find((descriptor) => {
      const rows: readonly string[] = descriptor.covers;
      return rows.includes("P1.double-left-agent-hub-gesture");
    });

    expect(shortcut).toMatchObject({
      kind: "shortcut",
      id: "P1.agentHubShortcut",
      owner: "P1",
      chord: "Alt+A",
      scope: "global",
    });
    expect(gesture).toMatchObject({
      kind: "composer",
      id: "P1.doubleLeftGesture",
      owner: "P1",
      feature: { slot: "gesture" },
    });
  });
});

describe("W5: P1's gate enables a control when each capability it needs is usable, available or a fallback (the shared gate's rule, #1675)", () => {
  test.each(P1_CAPABILITY_CASES)("$name", (item) => {
    const enabled: string[] = [];
    const disabled: string[] = [];
    for (const descriptor of P1_DESCRIPTORS) {
      const required: readonly CapabilityKey[] = descriptor.requires;
      const ready = required.every((key) => isUsable(item.map, key));
      (ready ? enabled : disabled).push(descriptor.id);
    }

    expect(sorted(disabled)).toEqual(sorted(item.disabled));
    expect(enabled.length + disabled.length).toBe(P1_DESCRIPTORS.length);
  });

  test("the terminal-only agents dashboard is unavailable under every map, and /hub needs nothing", () => {
    for (const item of P1_CAPABILITY_CASES) {
      expect(item.disabled).toEqual(
        expect.arrayContaining(["P1.agentsCommand", "P1.agentsDashboard"]),
      );
    }
    expect(
      P1_DESCRIPTORS.find((descriptor) => descriptor.id === "P1.hubCommand")?.requires,
    ).toEqual([]);
  });

  test("a fallback transcript enables P1's focused agent in the shared gate, as in P1's client (#1675)", () => {
    const fallback = P1_CAPABILITY_CASES.find(
      (item) => item.map[P1CapabilityKeys.transcript]?.state === "fallback",
    );
    const focused = P1_DESCRIPTORS.find((descriptor) => descriptor.id === "P1.focusedAgent");
    if (fallback === undefined || focused === undefined) {
      throw new Error("The fallback transcript case or the focused descriptor is missing.");
    }

    expect(isDescriptorAvailable(focused, fallback.map)).toBe(true);
  });
});

/** Runs a roster scenario through the real store, with its default retention, and checks what it holds. */
function expectRoster(scenario: RosterScenario): void {
  const clock = fixtureClock(FIXTURE_START);
  const store = fixtureRosterStore(clock);
  for (const step of scenario.steps) {
    clock.set(step.at);
    if (step.kind === "snapshot") store.mergeSnapshot(step.agents);
    else store.ingestNotification(step.event, step.seq);
  }
  const snapshot = store.getSnapshot();
  expectWorkers(snapshot.active, snapshot.agents, scenario.active);
  expectWorkers(snapshot.recent, snapshot.agents, scenario.recent);
}

/**
 * The workers the roster holds under `keys`, in order, as the expectations describe them. A key the
 * roster does not hold leaves a gap, so the comparison fails rather than passing on a shorter list.
 */
function expectWorkers(
  keys: readonly string[],
  agents: Readonly<Record<string, RosterAgent | undefined>>,
  expected: readonly WorkerExpectation[],
): void {
  expect(keys).toHaveLength(expected.length);
  const observed = keys.flatMap((key, index) => {
    const agent = agents[key];
    const want = expected[index];
    if (agent === undefined || want === undefined) return [];
    const got: WorkerExpectation =
      want.durationMs === undefined
        ? { id: agent.id, status: agent.status }
        : { id: agent.id, status: agent.status, durationMs: agent.metrics.durationMs ?? null };
    return [got];
  });
  expect(observed).toEqual(expected);
}

describe("CC8: the roster keeps lifecycle order, joins progress and retains finished workers", () => {
  test.each(ROSTER_ORDERING_SCENARIOS)("ordering: $name", (scenario) => {
    expectRoster(scenario);
  });

  test.each(PROGRESS_JOIN_SCENARIOS)("progress: $name", (scenario) => {
    expectRoster(scenario);
  });

  test.each(RETENTION_SCENARIOS)("retention: $name", (scenario) => {
    expectRoster(scenario);
  });
});

describe("CC5: the byte cursor places each page or drops it, and the focused view shows only visible turns", () => {
  test.each(TRANSCRIPT_CURSOR_SCENARIOS)("cursor: $name", (scenario) => {
    let state: TranscriptTailState = EMPTY_TRANSCRIPT_TAIL;
    for (const step of scenario.steps) {
      const askFrom = requestOffset(state, step.recordedFile);
      expect(askFrom).toBe(step.askFrom);
      state = applyTranscriptPage(state, step.page, askFrom);
      expect({
        file: state.sessionFile,
        cursor: state.cursor,
        shown: state.messages.length,
      }).toEqual(step.after);
    }
  });

  test("the focused view shows the visible turns in order and hides the custom note", () => {
    const rows = toThreadMessages(FOCUSED_TRANSCRIPT_PAGE.messages, 0);

    expect(rows.map((row) => row.role)).toEqual(FOCUSED_TRANSCRIPT_ROLES);
    expect(toReadonlyThreadMessages(rows).map((row) => row.role)).toEqual(FOCUSED_TRANSCRIPT_ROLES);
  });
});

/** What a fake omp session answers a command with: a reply, or omp's own error text for a refused steer. */
interface OmpAnswer {
  readonly reply?: { readonly cancelled: boolean } | "accepted";
  readonly ompError?: string;
}

/** A fake chat session port: it records every request it is sent, and answers as `answer` says. */
function fakeSession(answer: OmpAnswer): {
  readonly session: SubagentSession;
  readonly sent: unknown[];
} {
  const sent: unknown[] = [];
  const session = {
    request: async (args: unknown) => {
      sent.push(args);
      if (answer.ompError !== undefined) {
        throw new AppFailure({
          code: "omp_error",
          message: answer.ompError,
          retryable: false,
          omp: { command: "steer_subagent", error: answer.ompError },
        });
      }
      return answer.reply === undefined || answer.reply === "accepted" ? {} : answer.reply;
    },
    setSubagentSubscription: async (args: { level: string }) => ({ level: args.level }),
  } as unknown as SubagentSession;
  return { session, sent };
}

/** The subagent client over `session`, with every P1 capability published except `withheld`. */
function commandClient(session: SubagentSession, withheld?: CapabilityKey): SubagentClient {
  const capabilities = CapabilityMap.parse(
    Object.fromEntries(
      Object.values(P1CapabilityKeys)
        .filter((key) => key !== withheld)
        .map((key) => [key, { state: "available", via: key.startsWith("host.") ? "host" : "rpc" }]),
    ),
  );
  return createSubagentClient({
    threadId: THREAD,
    session,
    runtime: new OmpRuntimeStore({ threadId: THREAD, transport: {} as OmpRuntimeTransport }),
    capabilities,
  });
}

/** Resolves to the reason a call was refused, or to undefined when the call resolved. */
function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("CC8: cancel and steer send the typed command, succeed or fail in plain words, and a call without its capability sends nothing", () => {
  test.each(SUBAGENT_COMMAND_CASES)("$name", async (item) => {
    const { session, sent } = fakeSession({ reply: item.reply, ompError: item.ompError });
    const client = commandClient(
      session,
      item.withoutCapability === undefined ? undefined : P1CapabilityKeys[item.withoutCapability],
    );
    const worker = SubagentId.parse(item.subagentId ?? "worker-1");
    const outcome = await rejectionOf(
      item.command === "cancel" ? client.cancel(worker) : client.steer(worker, item.message ?? ""),
    );

    // The whole call, not only its method: the worker, the message and the thread must be the ones asked for.
    const call =
      item.command === "cancel"
        ? { method: "cancel_subagent", params: { subagentId: worker } }
        : { method: "steer_subagent", params: { subagentId: worker, message: item.message } };
    expect(sent).toEqual(item.expect.sent ? [{ threadId: THREAD, ...call }] : []);
    if (item.expect.outcome === "resolves") {
      expect(outcome).toBeUndefined();
    } else {
      expect(outcome).toBeInstanceOf(AppFailure);
      expect(outcome).toMatchObject({
        appError: { code: item.expect.code, retryable: item.expect.retryable },
      });
    }
  });

  test("a failed steer keeps the typed text and never shows omp's own words", () => {
    const failure = new AppFailure({
      code: "conflict",
      message: OMP_NOT_RUNNING_TEXT,
      retryable: true,
      omp: { command: "steer_subagent", error: OMP_NOT_RUNNING_TEXT },
    });
    const words = steerFailureMessage(failure);
    const draft = steerSendFailed(
      { ...EMPTY_STEER_DRAFT, text: "Check the failing test first." },
      words,
    );

    expect(words).not.toContain("Subagent not running");
    expect(draft.text).toBe("Check the failing test first.");
    expect(draft.sending).toBe(false);
  });

  test("a steer refusal says the message was not taken, with no busy, background or finished reason", () => {
    const failure = new AppFailure({
      code: "conflict",
      message: OMP_NOT_RUNNING_TEXT,
      retryable: true,
      omp: { command: "steer_subagent", error: OMP_NOT_RUNNING_TEXT },
    });

    const words = steerFailureMessage(failure);
    expect(words).not.toMatch(/busy|background command|finished|cancelled|subagent not running/i);
    expect(words).toMatch(/Your text is still here/);
  });

  test.fails("omp's steer refusal is not read by its wording: without a code it is not a conflict (#1676)", async () => {
    const { session } = fakeSession({ ompError: OMP_NOT_RUNNING_TEXT });
    const outcome = await rejectionOf(commandClient(session).steer(WORKER, "Check it."));

    if (!(outcome instanceof AppFailure)) throw new Error("omp's refusal did not fail the steer.");
    expect(outcome.appError.code).not.toBe("conflict");
  });
  test("cancelled:false is a typed not-found answer, not a conflict (#1686)", async () => {
    const { session } = fakeSession({ reply: { cancelled: false } });
    const outcome = await rejectionOf(commandClient(session).cancel(WORKER));

    expect(outcome).toMatchObject({
      appError: { code: "not_found", retryable: false },
    });
  });
  test("a refused cancel reads as plain words, not as a code", () => {
    expect(CANCEL_REFUSED_MESSAGE).not.toMatch(/conflict|omp_error|cancel_subagent/);
  });

  test("a refused cancel says the worker is still running and offers Cancel again", () => {
    expect(CANCEL_REFUSED_MESSAGE).toMatch(/still running/);
    expect(CANCEL_REFUSED_MESSAGE).toMatch(/Try Cancel again/);
    expect(CANCEL_REFUSED_MESSAGE).not.toMatch(/background command|busy|finished|cancelled/i);
  });
});

describe("CC8: an advisor note keeps the age omp sent, and its batch stays on the transcript", () => {
  // The card that shows `T-<n>` is not in this module yet (#1666). This gate checks the age through the converter:
  // the converted row keeps omp's batch details, and each note's turnsAgo is the count omp's rule gives it.
  test.each(ADVISOR_NOTE_AGE_CASES)("$name", (item) => {
    const message = advisorBatchMessage([item.note]);
    const rows = toThreadMessages([message], 0);
    const notes = [{ ...item.note, turnsAgo: item.expectTurnsAgo }];

    expect(isHiddenTranscriptMessage(message)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata?.custom).toEqual(
      expect.objectContaining({ ompCustomDetails: { notes } }),
    );
  });
});

describe("W5: advisor settings fixtures carry a compare-and-set write and its conflict; the store's compare-and-set is untested until #1666", () => {
  test("the fixture write names the revision it read, and its result has a new one", () => {
    expect(ADVISOR_ENABLED_WRITE.expectedRevision).toBe(
      ADVISOR_ENABLED_WRITE_RESULT.previousRevision,
    );
    expect(ADVISOR_ENABLED_WRITE_RESULT.revision).not.toBe(ADVISOR_ENABLED_WRITE.expectedRevision);
  });

  test("the stale-write fixture is a conflict that is not retryable as it stands", () => {
    expect(ADVISOR_STALE_WRITE_CONFLICT).toMatchObject({ code: "conflict", retryable: false });
  });

  test("the section groups the eight advisor pins, and the settings descriptor names one of them", () => {
    expect(ADVISOR_SECTION_KEYS).toHaveLength(8);
    expect(P1_DESCRIPTORS.find((descriptor) => descriptor.kind === "setting")).toMatchObject({
      key: "advisor.enabled",
      section: "model/Advisor",
    });
    expect(ADVISOR_SECTION_KEYS).toContain("advisor.enabled");
  });
});

/**
 * Every string a person reads in a view model, minus the internal keys the view never shows. `task` is the
 * assignment text omp recorded for the worker: content the person wrote or omp received, not a label, so the
 * internal-words check does not apply to it. Its preamble has its own marker (#1687).
 */
function visibleText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) visibleText(item, out);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (
        !["key", "state", "view", "lifecycle", "tone", "selected", "code", "task"].includes(key)
      ) {
        visibleText(item, out);
      }
    }
  }
  return out;
}

/** The named hub state. A name the fixtures do not hold fails the test rather than building an empty panel. */
function stateSpec(name: string): HubStateSpec {
  const spec = HUB_STATE_FIXTURES[name];
  if (spec === undefined) throw new Error(`The hub state ${name} is not in the fixtures.`);
  return spec;
}

describe("CC4: every hub state builds plain words, and every unavailable control says why", () => {
  test.each(Object.keys(HUB_STATE_FIXTURES))("%s", (name) => {
    const model: HubModel = buildHubModel(hubStateInput(stateSpec(name)));

    for (const text of visibleText(model)) {
      expect(text).not.toMatch(INTERNAL_WORDS);
    }
    if (model.inspector?.cancel.state === "unavailable") {
      expect(model.inspector.cancel.reason.length).toBeGreaterThan(0);
    }
    if (model.inspector?.transcript.state === "unavailable") {
      expect(model.inspector.transcript.reason.length).toBeGreaterThan(0);
    }
  });

  test("a running worker shows a ready cancel control under its plain title", () => {
    const model = buildHubModel(hubStateInput(stateSpec("running")));

    expect(model.inspector?.title).toBe("Index the repository");
    expect(model.inspector?.cancel.state).toBe("ready");
  });

  test("a refused cancel shows the plain refusal, and an unavailable cancel says why", () => {
    const refused = buildHubModel(hubStateInput(stateSpec("cancel refused")));
    const unavailable = buildHubModel(hubStateInput(stateSpec("cancel unavailable")));

    expect(refused.inspector?.cancel).toEqual({
      state: "refused",
      message: CANCEL_REFUSED_MESSAGE,
    });
    expect(unavailable.inspector?.cancel).toEqual({
      state: "unavailable",
      reason: "This version of omp cannot cancel agents.",
    });
  });

  test("a finished worker hides its cancel control", () => {
    const model = buildHubModel(hubStateInput(stateSpec("finished")));

    expect(model.inspector?.cancel.state).toBe("hidden");
  });

  test("empty, loading, error and unavailable states list no worker, and an error keeps omp's code", () => {
    for (const name of ["loading", "empty", "error", "unavailable"]) {
      const model = buildHubModel(hubStateInput(stateSpec(name)));
      expect(model.sections.flatMap((section) => section.rows)).toEqual([]);
    }
    expect(buildHubModel(hubStateInput(stateSpec("error"))).error?.code).toBe("omp_error");
  });

  test("workers grouped by parent are headed by the task call they came from", () => {
    const model = buildHubModel(hubStateInput(stateSpec("grouped by parent")));
    const headings = model.sections.map((section) => section.heading);

    expect(headings).toEqual(expect.arrayContaining(["From task call 1", "From task call 2"]));
  });

  test("the inspector shows the worker's own assignment without omp's preamble (#1687)", () => {
    const model = buildHubModel(hubStateInput(stateSpec("running")));

    expect(model.inspector?.task).toBe("long_probe_child: run one slow step.");
    expect(model.inspector?.task).not.toContain("Complete assignment thoroughly:");
  });
});

/**
 * The P1 folder. Vitest runs from the web app (`apps/web`), as the repository's source-scan tests do; the
 * repository root is accepted too. `import.meta.url` is not a file URL under vitest's environment, so it is not used.
 */
function p1Folder(): string {
  const fromWeb = join(process.cwd(), "src/modules/P1");
  return existsSync(fromWeb) ? fromWeb : join(process.cwd(), "apps/web/src/modules/P1");
}

/** The P1 source files that ship: no tests, fixtures, test folder or playgrounds. */
function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "test" && entry !== "fixtures") productionFiles(full, out);
    } else if (
      /\.tsx?$/.test(entry) &&
      !/\.test\.tsx?$/.test(entry) &&
      !entry.includes("playground")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("W5: P1 reaches the rest of the app through typed ports, never through T5 or the server", () => {
  test("no shipped P1 file imports T5, the server, omp's own code or a serving-platform module", () => {
    const root = p1Folder();
    const offenders = productionFiles(root)
      .filter((file) => FORBIDDEN_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));

    expect(offenders).toEqual([]);
  });
});

/**
 * One session entry as omp wrote it (the harness adds `id` and `parentId` when it seeds a chat), and
 * what the transcript must show for it. Built from the entries in a real session store, with
 * private paths and content replaced; never from a shape someone wrote by hand.
 */
export interface RealEntry {
  /** "custom_message irc:incoming: a message from another agent": the entry kind, then the shape. */
  readonly name: string;
  readonly entry: Readonly<Record<string, unknown>>;
  /** Text the transcript must show for this entry, as one note. Empty when it is hidden. */
  readonly shows: readonly string[];
  /** The entry is for the model alone: none of its text may be on the page. */
  readonly hidden: boolean;
  /** For a hidden entry: a phrase of its text, to prove it is not shown. */
  readonly hiddenText?: string;
}

const AT = "2026-10-03T12:00:00.000Z";

/** Real `custom_message` entries: the kinds omp shows, and the two it keeps for the model. */
export const U1_REAL_ENTRIES: readonly RealEntry[] = [
  {
    name: "custom_message irc:incoming: a message from another agent",
    entry: {
      type: "custom_message",
      customType: "irc:incoming",
      content:
        "<irc>\nIncoming IRC message from agent `Reviewer`:\n\nReviewer: I need one measurement I cannot take (no shell). Could you run `pdftotext -layout resume.pdf -` and paste the output?\n</irc>",
      display: true,
      attribution: "agent",
      details: {
        id: "158df670bc17c016",
        from: "Reviewer",
        message:
          "Reviewer: I need one measurement I cannot take (no shell). Could you run `pdftotext -layout resume.pdf -` and paste the output?",
      },
      timestamp: AT,
    },
    shows: [
      "Message from Reviewer",
      "I need one measurement I cannot take (no shell).",
      "pdftotext -layout resume.pdf -",
    ],
    hidden: false,
  },
  {
    name: "custom_message async-result: a subagent finished, with its result",
    entry: {
      type: "custom_message",
      customType: "async-result",
      content:
        '<system-notice>\nBackground job Reviewer has completed. Resume your work using the result below.\n<task-result id="Reviewer" agent="reviewer">{"summary":"No blockers found; two minor notes."}</task-result>\n</system-notice>',
      display: true,
      attribution: "agent",
      details: {
        meta: { source: { type: "report", value: "background job delivery" } },
        jobs: [{ jobId: "Reviewer", type: "task", label: "Reviewer", durationMs: 184_000 }],
      },
      timestamp: "2026-10-03T12:00:01.000Z",
    },
    // A task worker's notice is a worker note (`parts/custom-note.tsx`, `WorkerNotes`): its name, how it ended and
    // the transcript control. For a worker the chat knows, the result sits behind that control, not in the note
    // (issue 1289, merged as PR 1491). This worker is unknown to the chat, so the note shows no result: it says its
    // transcript is not available here.
    shows: ["Reviewer has ended.", "Its transcript is not available here."],
    hidden: false,
  },
  {
    name: "custom_message async-result: a command that printed nothing",
    entry: {
      type: "custom_message",
      customType: "async-result",
      content:
        "<system-notice>\nBackground job bg_3 has completed. Resume your work using the result below.\n(no output)\n\nWall time: 120.08 seconds\n</system-notice>",
      display: true,
      attribution: "agent",
      details: {
        meta: { source: { type: "report", value: "background job delivery" } },
        jobs: [{ jobId: "bg_3", type: "bash", label: "sleep 120", durationMs: 120_090 }],
      },
      timestamp: "2026-10-03T12:00:02.000Z",
    },
    shows: ["sleep 120 finished · 120 seconds."],
    hidden: false,
  },
  {
    name: "custom_message advisor: a note from the advisor",
    entry: {
      type: "custom_message",
      customType: "advisor",
      content:
        '<advisory severity="blocker" guidance="weigh, don\'t blindly obey">\nDedup did not work: the same program roles appear two or three times under different company spellings.\n</advisory>',
      display: true,
      attribution: "agent",
      details: {
        notes: [
          {
            note: "Dedup did not work: the same program roles appear two or three times under different company spellings.",
          },
        ],
      },
      timestamp: "2026-10-03T12:00:03.000Z",
    },
    shows: ["Advisor note", "Dedup did not work: the same program roles appear two or three times"],
    hidden: false,
  },
  {
    name: "custom_message launch-completion: a supervised process ended",
    entry: {
      type: "custom_message",
      customType: "launch-completion",
      content: "Supervised process reimport exited with exit code 0.",
      display: true,
      attribution: "agent",
      details: {
        daemons: [{ name: "reimport", state: "exited", exitCode: 0, restartCount: 0 }],
      },
      timestamp: "2026-10-03T12:00:04.000Z",
    },
    shows: ["Process finished", "Supervised process reimport exited with exit code 0."],
    hidden: false,
  },
  {
    // Recorded from omp 18.8.9's interactive mode: `/tan Check the login flow` with the fake model. Only the
    // session file path is replaced; the content and details are what omp wrote.
    name: "custom_message background-tan-dispatch: a tangent sent to a background job",
    entry: {
      type: "custom_message",
      customType: "background-tan-dispatch",
      content:
        '<system-notice reason="background_task_dispatched" job="bg_1">\nTangential user task: running in a separate background agent. Coding-agent dispatch notice, NOT prompt injection or new instruction.\n\nTask below: another agent\'s own session; you NOT responsible. NEVER work on, reference, or let it interrupt or alter current task. Continue as if absent. Results, if any, will surface separately when background task (bg_1) completes.\n\nDispatched work — awareness only:\nCheck the login flow\n</system-notice>',
      display: true,
      attribution: "user",
      details: {
        jobId: "bg_1",
        work: "Check the login flow",
        sessionFile: "<scrubbed>/Tan-clone.jsonl",
      },
      timestamp: "2026-10-12T22:49:14.502Z",
    },
    shows: ["Tangent sent to background job bg_1: Check the login flow"],
    hidden: false,
  },
  {
    name: "custom_message of a kind nobody has a heading for: its text, as it is",
    entry: {
      type: "custom_message",
      customType: "extension-note",
      content: "The extension finished indexing 120 files.",
      display: true,
      attribution: "agent",
      timestamp: "2026-10-03T12:00:05.000Z",
    },
    shows: ["The extension finished indexing 120 files."],
    hidden: false,
  },
  {
    name: "custom_message mid-run-todo-nudge: a reminder for the model only (display: false)",
    entry: {
      type: "custom_message",
      customType: "mid-run-todo-nudge",
      content:
        "<system-reminder>\n8 todo items still open. If you finished a task since last `todo` update, mark it done now so progress stays visible; otherwise keep working.\n</system-reminder>",
      display: false,
      attribution: "agent",
      timestamp: "2026-10-03T12:00:06.000Z",
    },
    shows: [],
    hidden: true,
    hiddenText: "todo items still open",
  },
  {
    name: "custom_message goal-continuation: a hidden steer for the model (display: false)",
    entry: {
      type: "custom_message",
      customType: "goal-continuation",
      content:
        "<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->\n\nContinue active goal.",
      display: false,
      attribution: "agent",
      timestamp: "2026-10-03T12:00:07.000Z",
    },
    shows: [],
    hidden: true,
    hiddenText: "Hidden continuation steer",
  },
];

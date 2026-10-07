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

/** Real `custom_message` entries: the four kinds omp shows and two it keeps for the model. */
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
    shows: ["Background job finished", "No blockers found; two minor notes."],
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
    shows: ["Background job finished", "(no output)", "Wall time: 120.08 seconds"],
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

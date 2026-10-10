import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppFailure, parseFixture } from "@omp-app/contracts";
import { z } from "zod";
import type { CommandParserContext } from "./gateway";
import { parseDumpReply, parseShareReply } from "./parsers";

// Real omp 18.6.1 replies, recorded through the A1 gateway by .data/record-793.ts (see the fixture's
// header for the scrubbing). `/share` uploaded to a local https stub; its link is scrubbed.
const recording = parseFixture(
  readFileSync(join(import.meta.dir, "fixtures", "share-dump.fixture.jsonl"), "utf8"),
);
if (!recording.ok) throw new Error(`share-dump fixture is invalid: ${recording.error.message}`);
const frames = recording.value.frames;

/** The frame fields these tests read; every other field of an omp frame is left alone. */
const RecordedFrame = z.looseObject({
  type: z.string(),
  command: z.unknown().optional(),
  data: z.unknown().optional(),
});

/** A command's prompt acknowledgement: omp says whether it ran the text as a command or sent it to the model. */
const PromptAcknowledgement = z.looseObject({ agentInvoked: z.boolean() });

/**
 * The reply to the `occurrence`th prompt of `command` in the recording: the command_output frames
 * written after that prompt line, up to its acknowledgement. A local command's acknowledgement comes
 * after its output; the recording ends there, so no prompt_result is required.
 */
function recordedReply(command: string, occurrence = 1): CommandParserContext {
  let matches = 0;
  let collecting = false;
  const outputs: { text: string }[] = [];
  for (const frame of frames) {
    const payload = RecordedFrame.parse(JSON.parse(frame.line));
    if (frame.dir === "stdin" && payload.type === "prompt" && payload.message === command) {
      matches += 1;
      collecting = matches === occurrence;
      continue;
    }
    if (!collecting) continue;
    if (payload.type === "command_output" && typeof payload.text === "string") {
      outputs.push({ text: payload.text });
    }
    if (payload.type === "response" && payload.command === "prompt") {
      return {
        command,
        agentInvoked: PromptAcknowledgement.parse(payload.data).agentInvoked,
        outputs,
        sessionUpdates: [],
        configUpdates: [],
      };
    }
  }
  throw new Error(`the recording has no reply to ${command} (occurrence ${occurrence})`);
}

/** A context for one command whose only output is `text`, as the gateway hands it to a parser. */
function replyWith(command: string, text: string, agentInvoked = false): CommandParserContext {
  return {
    command,
    agentInvoked,
    outputs: [{ text }],
    sessionUpdates: [],
    configUpdates: [],
  };
}

/** The app failure a parser throws, or a test failure when it accepts the reply. */
function refusalOf(parse: () => unknown): AppFailure {
  try {
    parse();
  } catch (error) {
    if (error instanceof AppFailure) return error;
    throw error;
  }
  throw new Error("the parser accepted a reply it should refuse");
}

const RECORDED_SHARE_TEXT = recordedReply("/share").outputs[0]?.text ?? "";
const RECORDED_ARCHIVE_TEXT = recordedReply("/dump all", 2).outputs[0]?.text ?? "";
const RECORDED_SESSION_TEXT = recordedReply("/dump", 2).outputs[0]?.text ?? "";

describe("/share replies recorded from omp 18.6.1", () => {
  test("the recorded reply is one viewer link line", () => {
    expect(recordedReply("/share").outputs).toHaveLength(1);
    expect(RECORDED_SHARE_TEXT.split("\n")).toHaveLength(1);
  });

  test("parses the recorded viewer link as an https share result", () => {
    const result = parseShareReply(recordedReply("/share"));
    expect(result.url).toBe("https://share.example.test/fixtureShare1#scrubbed-share-key");
    expect(result.gistUrl).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  test("reads the gist line and the trimmed note in omp's order (builtin-collaboration.ts:296-298)", () => {
    const url = "https://share.example.test/abc1234567#key";
    const gist = "https://gist.github.com/example/0123456789abcdef";
    const result = parseShareReply(
      replyWith(
        "/share",
        [
          `Share URL: ${url}`,
          `Gist: ${gist}`,
          "Note: large content was trimmed to fit the share size limit.",
        ].join("\n"),
      ),
    );
    expect(result).toEqual({ url, gistUrl: gist, truncated: true });
  });

  test("omp's failed upload is an unavailable, retryable failure with a plain message (builtin-collaboration.ts:302)", () => {
    const failure = refusalOf(() =>
      parseShareReply(
        replyWith(
          "/share",
          "Failed to share session: Share upload to https://share.example.test failed: HTTP 500",
        ),
      ),
    );
    expect(failure.appError).toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "omp could not share this chat. Try again in a moment.",
    });
  });

  test("a share link that is not https is refused with its own plain unavailable message", () => {
    const failure = refusalOf(() =>
      parseShareReply(replyWith("/share", RECORDED_SHARE_TEXT.replace("https://", "http://"))),
    );
    expect(failure.appError).toMatchObject({
      code: "unavailable",
      retryable: false,
      message: "The share server does not use https, so the link can't be shown here.",
    });
  });

  test("a line omp does not print after the link is an internal failure", () => {
    const failure = refusalOf(() =>
      parseShareReply(replyWith("/share", `${RECORDED_SHARE_TEXT}\nextra line`)),
    );
    expect(failure.appError.code).toBe("internal");
  });

  test("a reply omp gave to the model is an internal failure", () => {
    const failure = refusalOf(() =>
      parseShareReply(replyWith("/share", RECORDED_SHARE_TEXT, true)),
    );
    expect(failure.appError.message).toBe("omp sent /share to the model instead of running it.");
  });

  test("two outputs or none is an internal failure", () => {
    const two: CommandParserContext = {
      ...replyWith("/share", RECORDED_SHARE_TEXT),
      outputs: [{ text: RECORDED_SHARE_TEXT }, { text: RECORDED_SHARE_TEXT }],
    };
    const none: CommandParserContext = { ...replyWith("/share", ""), outputs: [] };
    expect(refusalOf(() => parseShareReply(two)).appError.code).toBe("internal");
    expect(refusalOf(() => parseShareReply(none)).appError.code).toBe("internal");
  });
});

describe("/dump replies recorded from omp 18.6.1", () => {
  test("a session dump opens with its system prompt or configuration and keeps omp's text", () => {
    const result = parseDumpReply(recordedReply("/dump", 2));
    expect(result.scope).toBe("session");
    expect(result.empty).toBe(false);
    expect(result.text).toBe(RECORDED_SESSION_TEXT);
    const openings = ["## System Prompt\n", "## Configuration\n"];
    expect(openings.some((opening) => result.text.startsWith(opening))).toBe(true);
  });

  test("with no messages, /dump still prints the session header and /dump all prints omp's message", () => {
    const session = parseDumpReply(recordedReply("/dump", 1));
    const all = parseDumpReply(recordedReply("/dump all", 1));
    expect(session.scope).toBe("session");
    expect(session.empty).toBe(false);
    expect(session.text.startsWith("## System Prompt\n")).toBe(true);
    expect(all).toEqual({ scope: "all", text: "No messages to dump yet.", empty: true });
  });

  test("/dump all keeps the archive report, which names the archive and its members", () => {
    const result = parseDumpReply(recordedReply("/dump all", 2));
    expect(result.scope).toBe("all");
    expect(result.empty).toBe(false);
    expect(result.text).toBe(RECORDED_ARCHIVE_TEXT);
    expect(result.text.startsWith("Session dump archive: ")).toBe(true);
    expect(result.text).toContain("\n  session.md\n");
    expect(result.text.endsWith("treat accordingly.")).toBe(true);
  });

  test("a reply in the other scope's shape is an internal failure", () => {
    const sessionAsArchive = refusalOf(() =>
      parseDumpReply(replyWith("/dump", RECORDED_ARCHIVE_TEXT)),
    );
    const archiveAsSession = refusalOf(() =>
      parseDumpReply(replyWith("/dump all", RECORDED_SESSION_TEXT)),
    );
    expect(sessionAsArchive.appError.code).toBe("internal");
    expect(archiveAsSession.appError.code).toBe("internal");
  });

  test("a command that is not /dump or /dump all is an internal failure", () => {
    const failure = refusalOf(() => parseDumpReply(replyWith("/dump foo", RECORDED_SESSION_TEXT)));
    expect(failure.appError.code).toBe("internal");
  });

  test("a reply omp gave to the model is an internal failure", () => {
    const failure = refusalOf(() =>
      parseDumpReply(replyWith("/dump", RECORDED_SESSION_TEXT, true)),
    );
    expect(failure.appError.message).toBe("omp sent /dump to the model instead of running it.");
  });
});

const SHARE_URL = "https://share.example.test/abc1234567#key";
const GIST_URL = "https://gist.github.com/example/0123456789abcdef";
const NOTE = "Note: large content was trimmed to fit the share size limit.";

function internalFailureOf(command: string, text: string): AppFailure {
  const parse = command === "/share" ? parseShareReply : parseDumpReply;
  return refusalOf(() => parse(replyWith(command, text)));
}

describe("the /share line shapes omp prints are the only ones accepted", () => {
  test("a valid https link under a different label is refused", () => {
    expect(internalFailureOf("/share", `Share link: ${SHARE_URL}`).appError.code).toBe("internal");
  });

  test("a gist line under a different label is refused", () => {
    const failure = internalFailureOf("/share", `Share URL: ${SHARE_URL}\nGist URL: ${GIST_URL}`);
    expect(failure.appError.code).toBe("internal");
  });

  test("a note with different wording is refused", () => {
    const failure = internalFailureOf(
      "/share",
      `Share URL: ${SHARE_URL}\nNote: large content was trimmed.`,
    );
    expect(failure.appError.code).toBe("internal");
  });

  test("the note placed before the gist line is refused", () => {
    const failure = internalFailureOf(
      "/share",
      `Share URL: ${SHARE_URL}\n${NOTE}\nGist: ${GIST_URL}`,
    );
    expect(failure.appError.code).toBe("internal");
  });

  test("a gist link that is not https is refused", () => {
    const failure = internalFailureOf(
      "/share",
      `Share URL: ${SHARE_URL}\nGist: http://gist.example.test/x`,
    );
    expect(failure.appError.code).toBe("internal");
  });
});

describe("share links must be plain https URLs", () => {
  test("a link with a username or password is refused", () => {
    const failure = internalFailureOf(
      "/share",
      "Share URL: https://user:pw@share.example.test/abc",
    );
    expect(failure.appError.code).toBe("internal");
  });

  test("a link with a space is refused", () => {
    const failure = internalFailureOf("/share", "Share URL: https://share.example.test/a b");
    expect(failure.appError.code).toBe("internal");
  });

  test("a link with a control character is refused", () => {
    const failure = internalFailureOf("/share", "Share URL: https://share.example.test/a\u0007b");
    expect(failure.appError.code).toBe("internal");
  });

  test("a link with a backslash is refused", () => {
    const failure = internalFailureOf("/share", "Share URL: https://share.example.test/a\\b");
    expect(failure.appError.code).toBe("internal");
  });
});

describe("the /dump archive report needs all three of its parts", () => {
  const lines = RECORDED_ARCHIVE_TEXT.split("\n");

  test("without its opening line it is refused", () => {
    const failure = internalFailureOf("/dump all", lines.slice(1).join("\n"));
    expect(failure.appError.code).toBe("internal");
  });

  test("without its contents line it is refused", () => {
    const failure = internalFailureOf("/dump all", [lines[0], ...lines.slice(2)].join("\n"));
    expect(failure.appError.code).toBe("internal");
  });

  test("without its closing warning it is refused", () => {
    const failure = internalFailureOf("/dump all", lines.slice(0, -1).join("\n"));
    expect(failure.appError.code).toBe("internal");
  });

  test("/dump all with extra words in its command is not a dump command", () => {
    const failure = internalFailureOf("/dump all extra", RECORDED_ARCHIVE_TEXT);
    expect(failure.appError.code).toBe("internal");
  });
});

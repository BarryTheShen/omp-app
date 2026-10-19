import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

// Two different markers: omp reads the agent folder's RULES.md and the project's .omp/RULES.md separately, so each file
// has its own text, and the request must carry both (one marker in both files would pass with either file alone).
const AGENT_MARKER = "RULES-AGENT-MARKER-1493";
const PROJECT_MARKER = "RULES-PROJECT-MARKER-1493";

realTest.setTimeout(180_000);
realTest.use({
  serverEnv: { FAKE_OPENAI_ENABLE_RULES: "1" },
  seedAgentFiles: { "RULES.md": `Always include ${AGENT_MARKER} in the response context.` },
  seedWorkspace: {
    files: { ".omp/RULES.md": `Always include ${PROJECT_MARKER} in the response context.` },
    gitRepo: false,
  },
});

interface RecordedMessage {
  readonly role?: string;
  readonly content?: unknown;
}

interface RecordedRequest {
  readonly messages?: readonly RecordedMessage[];
}

function readRequests(text: string): RecordedRequest[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedRequest);
}

realTest(
  "real omp sends the agent folder's and the project's RULES.md bodies in the provider request",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "rules_request_2073");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    const requests = readRequests(
      await readFile(join(dirname(realApp.agentDir), "requests.jsonl"), "utf8"),
    );
    const request = requests.find((candidate) =>
      candidate.messages?.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content ?? "").includes("rules_request_2073"),
      ),
    );
    expect(request).toBeDefined();
    const systemText = (request?.messages ?? [])
      .filter((message) => message.role === "system")
      .map((message) => JSON.stringify(message.content ?? ""))
      .join("\n");
    expect(systemText).toContain(AGENT_MARKER);
    expect(systemText).toContain(PROJECT_MARKER);
    expect(realApp.problems).toEqual([]);
  },
);

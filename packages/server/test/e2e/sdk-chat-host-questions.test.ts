/**
 * Questions the agent asks without waiting (`ask_async`, `chat-host/questions.ts`), end to end on the fake model
 * provider: the model asks through the tool, the questions are kept in the chat's session and listed, and the answers of
 * one ask wait until each question has one, then reach the agent together as one message from the person: a new turn
 * when it is idle, between its steps while it works. The person can send the waiting answers early. Runs from source
 * and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatEvent, QuestionRecord } from "@omp-app/contracts/chat-host";
import {
  type Chat,
  chatHostChats,
  lastReply,
  PROGRAMS,
  realTest,
  resultOf,
} from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

const ASK = {
  questions: [
    {
      id: "publish",
      question: "How should the project be published?",
      header: "Publish",
      context: "Issues on a public repository can be opened by **anyone**.",
      options: [
        { label: "Public copy", description: "A new repository with the code only" },
        { label: "This repository" },
      ],
      recommended: 0,
    },
    { id: "name", question: "What should the public copy be called?" },
  ],
};

/** The text of every user message the chat started, in order. */
function userTexts(chat: Chat): string[] {
  return chat.events.flatMap(({ event }) => {
    if (event.type !== "message_start" || event.message.role !== "user") return [];
    const { content } = event.message;
    return [
      typeof content === "string"
        ? content
        : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    ];
  });
}

const agentEnd = (event: ChatEvent): boolean => event.type === "agent_end";

describe("the chat host's questions without waiting", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the agent asks and goes on; answers wait until the ask is answered, then go as one message`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: `call_tool ask_async ${JSON.stringify(ASK)}` });
        await chat.next(resultOf("1"));
        expect(lastReply(chat)).toStartWith("tool said: Asked 2 questions (publish, name).");
        const announced = chat.events.flatMap(({ event }) =>
          event.type === "question_record" ? [event.record] : [],
        );
        expect(announced.map((record) => record.questionId)).toEqual(["publish", "name"]);

        const { questions } = await chat.client.request("get_questions", {});
        expect(questions).toMatchObject([
          {
            questionId: "publish",
            header: "Publish",
            context: "Issues on a public repository can be opened by **anyone**.",
            options: [
              { label: "Public copy", description: "A new repository with the code only" },
              { label: "This repository" },
            ],
            multi: false,
            recommended: 0,
            answer: null,
          },
          { questionId: "name", options: [], answer: null },
        ]);
        const [publish, name] = questions as [QuestionRecord, QuestionRecord];
        const sentBefore = userTexts(chat).length;

        // The first answer waits for the other question, and can still be changed.
        const first = await chat.client.request("answer_question", {
          id: publish.id,
          picked: ["This repository"],
        });
        expect(first.record.answer).toMatchObject({ picked: ["This repository"], held: true });
        const changed = await chat.client.request("answer_question", {
          id: publish.id,
          picked: ["Public copy"],
          note: "keep issues off",
        });
        expect(changed.record.answer).toMatchObject({
          picked: ["Public copy"],
          note: "keep issues off",
          skipped: false,
          held: true,
        });
        expect(userTexts(chat)).toHaveLength(sentBefore);
        // A choice the question does not have, or none at all, is refused.
        await expect(
          chat.client.request("answer_question", { id: name.id, picked: ["Elsewhere"] }),
        ).rejects.toMatchObject({ message: '"Elsewhere" is not a choice of this question' });
        await expect(
          chat.client.request("answer_question", { id: name.id, picked: [] }),
        ).rejects.toMatchObject({ message: "An answer needs a choice or a written answer" });

        // The skip answers the ask's last question: both go together, as one message that starts the next turn.
        const mark = chat.events.length;
        const skipped = await chat.client.request("skip_question", { id: name.id });
        expect(skipped.record.answer).toMatchObject({ picked: [], skipped: true });
        expect(skipped.record.answer?.held).toBeUndefined();
        expect(skipped.record.answer?.sentAt).toBeNumber();
        await chat.nextAfter(mark, agentEnd);
        expect(userTexts(chat).slice(sentBefore)).toEqual([
          'Answers to your questions:\n\n"Publish" (publish):\nPublic copy\nNote: keep issues off\n\n"What should the public copy be called?" (name): skipped; decide it yourself.',
        ]);
        expect(lastReply(chat)).toBe("pong");

        // Kept as sent, and sent once only.
        const listed = await chat.client.request("get_questions", {});
        expect(listed.questions[0]?.answer).toMatchObject({
          picked: ["Public copy"],
          skipped: false,
        });
        expect(listed.questions[0]?.answer?.held).toBeUndefined();
        expect(listed.questions[0]?.answer?.sentAt).toBeNumber();
        await expect(
          chat.client.request("answer_question", { id: publish.id, picked: ["This repository"] }),
        ).rejects.toMatchObject({ message: "This question was already answered" });
        expect((await chat.client.request("send_answers", {})).records).toEqual([]);
      },
      60_000,
    );

    programTest(
      `${program.name}: the person can send the answers ready so far; the rest of the ask goes on its own later`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const two = {
          questions: [
            { id: "color", question: "Which color?" },
            { id: "size", question: "Which size?" },
          ],
        };
        await chat.client.request("prompt", { text: `call_tool ask_async ${JSON.stringify(two)}` });
        await chat.next(resultOf("1"));
        const { questions } = await chat.client.request("get_questions", {});
        const [color, size] = questions as [QuestionRecord, QuestionRecord];
        const sentBefore = userTexts(chat).length;

        await chat.client.request("answer_question", { id: color.id, picked: [], typed: "Green" });
        const early = chat.events.length;
        const { records } = await chat.client.request("send_answers", {});
        expect(records.map((record) => record.questionId)).toEqual(["color"]);
        expect(records[0]?.answer?.sentAt).toBeNumber();
        await chat.nextAfter(early, agentEnd);

        const late = chat.events.length;
        const { record } = await chat.client.request("answer_question", {
          id: size.id,
          picked: [],
          typed: "Large",
        });
        expect(record.answer?.sentAt).toBeNumber();
        await chat.nextAfter(late, agentEnd);
        expect(userTexts(chat).slice(sentBefore)).toEqual([
          'Answer to your question "Which color?" (color):\nGreen',
          'Answer to your question "Which size?" (size):\nLarge',
        ]);
      },
      60_000,
    );

    programTest(
      `${program.name}: an answer while the agent works goes in between its steps, in the same run`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const one = { questions: [{ id: "color", question: "Which color?" }] };
        await chat.client.request("prompt", { text: `call_tool ask_async ${JSON.stringify(one)}` });
        await chat.next(resultOf("1"));
        const { questions } = await chat.client.request("get_questions", {});
        const id = questions[0]?.id ?? "";

        const mark = chat.events.length;
        await chat.client.request("prompt", { text: "slow_tool 3" });
        await chat.nextAfter(mark, (event) => event.type === "tool_execution_start");
        await chat.client.request("answer_question", { id, picked: [], typed: "Green" });
        await chat.next(resultOf("3"));

        const run = chat.events.slice(mark).map(({ event }) => event);
        expect(run.filter((event) => event.type === "agent_start")).toHaveLength(1);
        const toolEnd = run.findIndex((event) => event.type === "tool_execution_end");
        const answered = run.findIndex(
          (event) =>
            event.type === "message_start" &&
            event.message.role === "user" &&
            JSON.stringify(event.message.content).includes("Answer to your question"),
        );
        expect(toolEnd).toBeGreaterThan(-1);
        expect(answered).toBeGreaterThan(toolEnd);
        expect(userTexts(chat).at(-1)).toBe(
          'Answer to your question "Which color?" (color):\nGreen',
        );
        expect(lastReply(chat)).toBe("pong");
      },
      60_000,
    );

    programTest(
      `${program.name}: a question the agent got wrong fails the call with the reason`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const twice = {
          questions: [{ id: "a", question: "Which?", options: [{ label: "X" }, { label: "X" }] }],
        };
        await chat.client.request("prompt", {
          text: `call_tool ask_async ${JSON.stringify(twice)}`,
        });
        await chat.next(resultOf("1"));
        expect(lastReply(chat)).toContain('Question a has the option "X" twice');
        expect((await chat.client.request("get_questions", {})).questions).toEqual([]);
      },
      60_000,
    );
  }
});

import {
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MessageActionBar } from "./branch-picker";

const message: ThreadMessageLike = {
  role: "assistant",
  id: "assistant-message",
  content: [{ type: "text", text: "answer" }],
  metadata: { custom: {} },
};

function Harness({
  disabled,
  messageRole = "assistant",
}: {
  readonly disabled: boolean;
  readonly messageRole?: "user" | "assistant";
}) {
  const currentMessage: ThreadMessageLike =
    messageRole === "user"
      ? { ...message, role: "user", content: [{ type: "text", text: "question" }] }
      : message;
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [currentMessage],
    onNew: async () => undefined,
    convertMessage: (value) => value,
    isRunning: disabled,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MessageByIndexProvider index={0}>
        <MessagePrimitive.Root>
          <MessageActionBar disabled={disabled} />
        </MessagePrimitive.Root>
      </MessageByIndexProvider>
    </AssistantRuntimeProvider>
  );
}

afterEach(cleanup);

describe("P3 message action composition", () => {
  test("assistant rows expose copy/regenerate and disable those actions while streaming", () => {
    const view = render(<Harness disabled />);
    expect(
      (screen.getByRole("button", { name: "Copy message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Regenerate message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    view.unmount();
  });

  test("user rows expose copy/edit without a regenerate action", () => {
    render(<Harness disabled={false} messageRole="user" />);
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Regenerate message" })).toBeNull();
  });
});

import {
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { P3MessageActions, type P3MessageActionsProps } from "./message-actions";

afterEach(cleanup);

interface HarnessProps extends P3MessageActionsProps {
  readonly messageRole: "user" | "assistant";
  readonly running?: boolean;
  readonly onReload?: (parentId: string | null) => void;
}

function Harness({ messageRole, running = false, onEdit, onReload }: HarnessProps) {
  const message: ThreadMessageLike = {
    role: messageRole,
    id: `${messageRole}-row`,
    content: [{ type: "text", text: "A message" }],
    metadata: { custom: {} },
  };
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [message],
    onNew: async () => undefined,
    onReload: onReload === undefined ? undefined : async (parentId) => onReload(parentId),
    convertMessage: (value) => value,
    isRunning: running,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MessageByIndexProvider index={0}>
        <MessagePrimitive.Root>
          <P3MessageActions onEdit={onEdit} />
        </MessagePrimitive.Root>
      </MessageByIndexProvider>
    </AssistantRuntimeProvider>
  );
}

describe("P3 message actions", () => {
  test("a user row offers Edit, which hands over the pressed button", () => {
    const onEdit = vi.fn();
    render(<Harness messageRole="user" onEdit={onEdit} />);

    const edit = screen.getByRole("button", { name: "Edit" });
    fireEvent.click(edit);

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.[0]).toBe(edit);
  });

  test("a user row without an editor offers no action", () => {
    render(<Harness messageRole="user" />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  test("an assistant row offers Regenerate by its full name, and asks the answer again", async () => {
    const onReload = vi.fn();
    render(<Harness messageRole="assistant" onReload={onReload} />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate response" }));

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  test("no action is offered while a turn streams", () => {
    render(
      <Harness messageRole="user" onEdit={() => undefined} onReload={() => undefined} running />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});

import {
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { P3MessageActions, type P3MessageActionsProps } from "./message-actions";

afterEach(cleanup);

interface HarnessProps extends P3MessageActionsProps {
  readonly messageRole: "user" | "assistant";
  readonly running?: boolean;
  readonly onReload?: (parentId: string | null) => void;
}

function Harness({
  messageRole,
  running = false,
  onEdit,
  onReload,
  otherVersions,
  onOpenOtherVersion,
}: HarnessProps) {
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
          <P3MessageActions
            onEdit={onEdit}
            onOpenOtherVersion={onOpenOtherVersion}
            otherVersions={otherVersions}
          />
        </MessagePrimitive.Root>
      </MessageByIndexProvider>
    </AssistantRuntimeProvider>
  );
}

const USER_ROW: ThreadMessageLike = {
  role: "user",
  id: "user-row",
  content: [{ type: "text", text: "A message" }],
  metadata: { custom: {} },
};

/**
 * A runtime whose run flag can change while its children stay the same elements: only what a child subscribes to can draw it
 * again.
 */
function RunningRuntime({
  running,
  children,
}: {
  readonly running: boolean;
  readonly children: ReactNode;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [USER_ROW],
    onNew: async () => undefined,
    convertMessage: (value) => value,
    isRunning: running,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
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
  test("a user row lists sibling chats as Other versions", () => {
    const opened: string[] = [];
    render(
      <Harness
        messageRole="user"
        onOpenOtherVersion={(threadId) => opened.push(threadId)}
        otherVersions={[{ threadId: ThreadId.parse("other-chat"), title: "Other chat" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Other versions" }));
    expect(screen.getByRole("list", { name: "Other versions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Other chat" }));
    expect(opened).toEqual(["other-chat"]);
    expect(screen.queryByRole("list", { name: "Other versions" })).toBeNull();
  });

  test("a user row with no sibling chats offers Edit but no Other versions button", () => {
    render(<Harness messageRole="user" onEdit={() => undefined} otherVersions={[]} />);

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Other versions" })).toBeNull();
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

  test("a user row's actions are not drawn again when a run starts or ends", () => {
    let drawn = 0;
    const row = (
      <Profiler
        id="user-row-actions"
        onRender={() => {
          drawn += 1;
        }}
      >
        <MessageByIndexProvider index={0}>
          <MessagePrimitive.Root>
            <P3MessageActions onEdit={() => undefined} />
          </MessagePrimitive.Root>
        </MessageByIndexProvider>
      </Profiler>
    );
    const view = render(<RunningRuntime running={false}>{row}</RunningRuntime>);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    drawn = 0;

    view.rerender(<RunningRuntime running>{row}</RunningRuntime>);
    view.rerender(<RunningRuntime running={false}>{row}</RunningRuntime>);

    expect(drawn).toBe(0);
  });
  test("keeps the assistant action host mounted while a turn streams", () => {
    const { container } = render(
      <Harness messageRole="assistant" onReload={() => undefined} running />,
    );

    expect(container.querySelector('[data-slot="p3-message-actions"]')).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Regenerate response" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});

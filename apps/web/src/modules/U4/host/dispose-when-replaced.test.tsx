import type { CapabilityMap, ThreadId, UiRequestId } from "@omp-app/contracts";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useEffect, useMemo } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OverlayHost, useStableOverlayHost } from "@/overlay";
import type { DialogRequest } from "../contract";
import { DialogHostController } from "./dialog-host";
import { useDisposeWhenReplaced } from "./dispose-when-replaced";

afterEach(cleanup);

const threadA = "thread-strict-a" as ThreadId;
const threadB = "thread-strict-b" as ThreadId;
const capabilities: CapabilityMap = { "omp.ui": { state: "available", via: "rpc" } };

interface Hosts {
  current: DialogHostController | undefined;
}

/** Builds one host per chat, as the app root does, and hands it to the helper under test. */
function HostOwner({ hosts, thread }: { readonly hosts: Hosts; readonly thread: ThreadId }) {
  const overlay = useStableOverlayHost();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new chat gets a new host.
  const host = useMemo(
    () =>
      new DialogHostController({
        overlay,
        capabilities,
        answerDialog: async () => undefined,
        render: () => null,
      }),
    [overlay, thread],
  );
  useDisposeWhenReplaced(host);
  useEffect(() => {
    hosts.current = host;
  }, [host, hosts]);
  return null;
}

function mount(thread: ThreadId, hosts: Hosts) {
  return render(
    <StrictMode>
      <OverlayHost>
        <HostOwner hosts={hosts} thread={thread} />
      </OverlayHost>
    </StrictMode>,
  );
}

function confirmRequest(id: string): DialogRequest {
  return { kind: "confirm", id: id as UiRequestId, title: id, message: "Continue?" };
}

function openAppDialog(
  host: DialogHostController,
  id: string,
  thread: ThreadId,
): { error?: unknown } {
  const outcome: { error?: unknown } = {};
  act(() => {
    void host
      .open(confirmRequest(id), { threadId: thread, origin: "app" })
      .catch((error: unknown) => {
        outcome.error = error;
      });
  });
  return outcome;
}

/** Lets pending effects, timers and microtasks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hostOf(hosts: Hosts): DialogHostController {
  if (hosts.current === undefined) throw new Error("the host was not built");
  return hosts.current;
}

describe("useDisposeWhenReplaced", () => {
  test("StrictMode's simulated remount keeps the host, so its dialogs still open", async () => {
    const hosts: Hosts = { current: undefined };
    mount(threadA, hosts);
    await settle();
    const outcome = openAppDialog(hostOf(hosts), "app-strict", threadA);
    await settle();
    expect(outcome.error).toBeUndefined();
    hostOf(hosts).dispose();
  });

  test("unmounting disposes the host, so later dialogs are refused", async () => {
    const hosts: Hosts = { current: undefined };
    const view = mount(threadA, hosts);
    await settle();
    const host = hostOf(hosts);
    view.unmount();
    await settle();
    const outcome = openAppDialog(host, "app-after-unmount", threadA);
    await settle();
    expect(outcome.error).toMatchObject({ message: "The dialog host has been disposed." });
  });

  test("a new chat gets a new host, the old one is disposed, and the new one stays open", async () => {
    const hosts: Hosts = { current: undefined };
    const view = mount(threadA, hosts);
    await settle();
    const first = hostOf(hosts);
    view.rerender(
      <StrictMode>
        <OverlayHost>
          <HostOwner hosts={hosts} thread={threadB} />
        </OverlayHost>
      </StrictMode>,
    );
    await settle();
    const second = hostOf(hosts);
    expect(second).not.toBe(first);
    const old = openAppDialog(first, "app-old-chat", threadA);
    const fresh = openAppDialog(second, "app-new-chat", threadB);
    await settle();
    expect(old.error).toMatchObject({ message: "The dialog host has been disposed." });
    expect(fresh.error).toBeUndefined();
    second.dispose();
  });
});

import type { AppClient } from "@omp-app/client";
import type { AppHealth, AppServerInfo, CapabilityMap } from "@omp-app/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useFirstAnswers } from "./use-first-answers";

const capabilities: CapabilityMap = {};
const serverInfo = {
  instanceId: "first-answers-test",
  serverVersion: "test",
  launchFolder: "/workspace" as never,
  logFile: "/workspace/log.txt",
  omp: { version: "18.9.1" },
} satisfies AppServerInfo;
const health: AppHealth = { status: "ok" };
function fakeClient(methods: {
  readonly capabilities: () => Promise<CapabilityMap>;
  readonly serverInfo: () => Promise<AppServerInfo>;
  readonly health: () => Promise<AppHealth>;
}): AppClient {
  const port = {
    capabilities: methods.capabilities,
    serverInfo: methods.serverInfo,
    health: methods.health,
  };
  return { port: () => port } as unknown as AppClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("first app answers", () => {
  test("a failed first request can retry all three calls and become ready", async () => {
    const firstError = new Error("First server info failed.");
    const calls = { capabilities: 0, serverInfo: 0, health: 0 };
    const client = fakeClient({
      capabilities: async () => {
        calls.capabilities += 1;
        return capabilities;
      },
      serverInfo: async () => {
        calls.serverInfo += 1;
        if (calls.serverInfo === 1) throw firstError;
        return serverInfo;
      },
      health: async () => {
        calls.health += 1;
        return health;
      },
    });
    const onFailure = vi.fn();
    const { result } = renderHook(() => useFirstAnswers(client, onFailure));

    await waitFor(() => expect(result.current.state.status).toBe("failed"));
    expect(onFailure).toHaveBeenCalledWith(firstError);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(calls).toEqual({ capabilities: 2, serverInfo: 2, health: 2 });
    expect(result.current.state).toMatchObject({
      status: "ready",
      capabilities,
      serverInfo,
      health,
    });
  });

  test("a late answer from the failed attempt cannot replace the retry result", async () => {
    const oldCapabilities = deferred<CapabilityMap>();
    const oldServerInfo = deferred<AppServerInfo>();
    const oldHealth = deferred<AppHealth>();
    const freshServerInfo = { ...serverInfo, instanceId: "retry-result" };
    let capabilitiesCall = 0;
    let serverInfoCall = 0;
    let healthCall = 0;
    const client = fakeClient({
      capabilities: () => {
        capabilitiesCall += 1;
        return capabilitiesCall === 1 ? oldCapabilities.promise : Promise.resolve(capabilities);
      },
      serverInfo: () => {
        serverInfoCall += 1;
        if (serverInfoCall === 1) return oldServerInfo.promise;
        if (serverInfoCall === 2) return Promise.reject(new Error("Retry after first failure."));
        return Promise.resolve(freshServerInfo);
      },
      health: () => {
        healthCall += 1;
        return healthCall === 1 ? oldHealth.promise : Promise.resolve(health);
      },
    });
    const onFailure = vi.fn();
    const { result } = renderHook(() => useFirstAnswers(client, onFailure));

    await waitFor(() => expect(serverInfoCall).toBe(1));
    act(() => result.current.retry());
    await waitFor(() => expect(serverInfoCall).toBe(2));
    await waitFor(() => expect(result.current.state.status).toBe("failed"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.state.serverInfo?.instanceId).toBe("retry-result");

    await act(async () => {
      oldCapabilities.resolve({ "client.test": { state: "available", via: "client" } });
      oldServerInfo.resolve({ ...serverInfo, instanceId: "late-answer" });
      oldHealth.resolve(health);
      await Promise.resolve();
    });
    expect(result.current.state.serverInfo?.instanceId).toBe("retry-result");
    expect(result.current.state.status).toBe("ready");
  });
});

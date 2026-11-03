import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserStatus, BrowserTarget } from "@omp-app/contracts";
import type { EdgeRelayState, RelayHost } from "../../../browser/edge-relay";
import {
  type BrowserRuntime,
  type BrowserSettingKey,
  createBrowserRuntime,
  type EdgeChoiceStore,
} from "./browser";

/** omp's global settings, as the runtime sees them. */
function settingsOf(values: Partial<Record<BrowserSettingKey, string | boolean>>) {
  const map = new Map<BrowserSettingKey, string | boolean>(
    Object.entries(values) as [BrowserSettingKey, string | boolean][],
  );
  return {
    map,
    read: async (key: BrowserSettingKey) => map.get(key) ?? null,
    write: async (key: BrowserSettingKey, value: string | boolean | null) => {
      if (value === null) map.delete(key);
      else map.set(key, value);
    },
  };
}

/** A relay that is started and stopped by the runtime only: nothing else on the machine runs one. */
function relay() {
  const did: string[] = [];
  let running = false;
  const state = (): EdgeRelayState => ({
    running,
    connected: false,
    browser: null,
    tabs: [],
    problem: null,
  });
  const host: RelayHost = {
    ensure: async () => {
      did.push("ensure");
      running = true;
    },
    stop: () => {
      if (!running) return;
      did.push("stop");
      running = false;
    },
    refresh: async () => state(),
    state,
  };
  return { did, host };
}

function choiceStore(until: number | null): EdgeChoiceStore & { saved: () => number | null } {
  let saved = until;
  return {
    read: async () => saved,
    write: async (next) => {
      saved = next;
    },
    saved: () => saved,
  };
}

const runtimes: BrowserRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

function runtimeOver(
  settings: ReturnType<typeof settingsOf>,
  edge: RelayHost,
  edgeChoice: EdgeChoiceStore,
  edgeMinutes = 30,
) {
  const runtime = createBrowserRuntime({
    browser: null,
    edge,
    edgeLink: "ssh -N -L 9224:127.0.0.1:9224 user@server",
    edgeChoice,
    settings,
    publish: () => undefined,
    publishLive: () => undefined,
    watchStreams: () => () => undefined,
    edgeMinutes,
  });
  runtimes.push(runtime);
  const handlers = runtime.registration.handlers as {
    status: () => Promise<BrowserStatus>;
    setTarget: (args: { target: BrowserTarget }) => Promise<BrowserStatus>;
  };
  return {
    runtime,
    status: () => handlers.status(),
    choose: (target: BrowserTarget) => handlers.setTarget({ target }),
  };
}

describe("which browser chats use: omp's browser.relay", () => {
  test("one set in omp's settings by hand outlives the server's start and has no end; choosing Your Edge starts the relay", async () => {
    const settings = settingsOf({ "browser.relay": true });
    const edge = relay();
    const store = choiceStore(null);
    const { runtime, status, choose } = runtimeOver(settings, edge.host, store);
    await runtime.ready;
    expect(settings.map.get("browser.relay")).toBe(true);
    expect(edge.did).toEqual([]);
    expect((await status()).target).toBe("edge");
    expect((await status()).edge.until).toBeNull();

    const chosen = await choose("edge");
    expect(edge.did).toEqual(["ensure"]);
    expect(chosen.edge.until).toBeNull();
    expect(store.saved()).toBeNull();
  });

  test("chosen in the panel, it ends at its time: the setting goes and the app's relay stops", async () => {
    const settings = settingsOf({});
    const edge = relay();
    const store = choiceStore(null);
    // 0.002 minutes: 120 ms.
    const { choose, status } = runtimeOver(settings, edge.host, store, 0.002);
    const chosen = await choose("edge");
    expect(chosen.target).toBe("edge");
    expect(chosen.edge.until).not.toBeNull();
    expect(store.saved()).toBe(chosen.edge.until);
    expect(settings.map.get("browser.relay")).toBe(true);

    await Bun.sleep(300);
    expect(settings.map.has("browser.relay")).toBe(false);
    expect(store.saved()).toBeNull();
    expect(edge.did).toEqual(["ensure", "stop"]);
    expect((await status()).target).toBe("off");
  });

  test("after a restart, a panel choice whose time ran out ends; one with time left keeps it", async () => {
    const ended = settingsOf({ "browser.relay": true });
    const endedStore = choiceStore(Date.now() - 1_000);
    const first = runtimeOver(ended, relay().host, endedStore);
    await first.runtime.ready;
    expect(ended.map.has("browser.relay")).toBe(false);
    expect(endedStore.saved()).toBeNull();

    const kept = settingsOf({ "browser.relay": true });
    const until = Date.now() + 60_000;
    const keptEdge = relay();
    const second = runtimeOver(kept, keptEdge.host, choiceStore(until));
    await second.runtime.ready;
    expect(kept.map.get("browser.relay")).toBe(true);
    expect((await second.status()).edge.until).toBe(until);
    expect(keptEdge.did).toEqual(["ensure"]);
  });

  test("choosing the chats' own browser takes out a hand-set relay too", async () => {
    const settings = settingsOf({ "browser.relay": true });
    const { runtime, choose } = runtimeOver(settings, relay().host, choiceStore(null));
    await runtime.ready;
    expect((await choose("off")).target).toBe("off");
    expect(settings.map.has("browser.relay")).toBe(false);
  });
});

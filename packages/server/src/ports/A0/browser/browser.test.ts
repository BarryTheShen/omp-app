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

function choiceStore(chosen: boolean): EdgeChoiceStore & { saved: () => boolean } {
  let saved = chosen;
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
  test("one set in omp's settings by hand outlives the server's start; choosing your own browser starts the relay", async () => {
    const settings = settingsOf({ "browser.relay": true });
    const edge = relay();
    const store = choiceStore(false);
    const { runtime, status, choose } = runtimeOver(settings, edge.host, store);
    await runtime.ready;
    expect(settings.map.get("browser.relay")).toBe(true);
    expect(edge.did).toEqual([]);
    expect((await status()).target).toBe("edge");

    await choose("edge");
    expect(edge.did).toEqual(["ensure"]);
    expect(store.saved()).toBe(true);
  });

  test("chosen in the panel, it stays until another choice, which stops its relay", async () => {
    const settings = settingsOf({});
    const edge = relay();
    const store = choiceStore(false);
    const { choose, status } = runtimeOver(settings, edge.host, store);
    const chosen = await choose("edge");
    expect(chosen.target).toBe("edge");
    expect(store.saved()).toBe(true);
    expect(settings.map.get("browser.relay")).toBe(true);
    expect((await status()).target).toBe("edge");
    expect(edge.did).toEqual(["ensure"]);

    expect((await choose("off")).target).toBe("off");
    expect(settings.map.has("browser.relay")).toBe(false);
    expect(store.saved()).toBe(false);
    expect(edge.did).toEqual(["ensure", "stop"]);
  });

  test("after a restart, a panel choice gets its relay again", async () => {
    const kept = settingsOf({ "browser.relay": true });
    const keptEdge = relay();
    const second = runtimeOver(kept, keptEdge.host, choiceStore(true));
    await second.runtime.ready;
    expect(kept.map.get("browser.relay")).toBe(true);
    expect((await second.status()).target).toBe("edge");
    expect(keptEdge.did).toEqual(["ensure"]);
  });

  test("choosing the chats' own browser takes out a hand-set relay too", async () => {
    const settings = settingsOf({ "browser.relay": true });
    const { runtime, choose } = runtimeOver(settings, relay().host, choiceStore(false));
    await runtime.ready;
    expect((await choose("off")).target).toBe("off");
    expect(settings.map.has("browser.relay")).toBe(false);
  });
});

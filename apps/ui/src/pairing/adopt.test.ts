import type { AppClient } from "@omp-app/client";
import { afterEach, describe, expect, test, vi } from "vitest";

const TOKEN_KEY = "omp-app.websocket-token";

/** A page at `host`, its tab holding the launch token, on a server that says whether the page is a device. */
function page(host: string, thisDeviceId: string | null | "older server") {
  const session = new Map([[TOKEN_KEY, "launch-token"]]);
  vi.stubGlobal("window", {
    location: { hostname: host, hash: "", pathname: "/", search: "" },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
      removeItem: (key: string) => session.delete(key),
    },
    navigator: {},
  });
  const asked: { url: string; authorization: string | undefined; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      asked.push({
        url,
        authorization: headers.authorization,
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ deviceId: "d-new" }), { status: 200 });
    }),
  );
  const client = {
    port: () => ({
      list: async () => {
        if (thisDeviceId === "older server") throw new Error("Unknown port A0.devices");
        return { devices: [], requests: [], thisDeviceId };
      },
    }),
  } as unknown as AppClient;
  return { session, asked, client };
}

async function adopt(client: AppClient): Promise<void> {
  vi.resetModules();
  const { adoptThisPage } = await import("./adopt");
  await adoptThisPage(client, "launch-token", { name: "iPhone", kind: "home-screen-app" });
}

afterEach(() => vi.unstubAllGlobals());

describe("a page signed in with the launch link", () => {
  test("from another device, it becomes a device once and forgets the token", async () => {
    const { session, asked, client } = page("devbox.tail1234.ts.net", null);
    await adopt(client);
    expect(asked).toEqual([
      {
        url: "/pair/adopt",
        authorization: "Bearer launch-token",
        body: { name: "iPhone", kind: "home-screen-app" },
      },
    ]);
    expect(session.has(TOKEN_KEY)).toBe(false);
  });

  test("a device already only forgets the token; this computer's page and an older server keep it", async () => {
    const device = page("devbox.tail1234.ts.net", "d-1");
    await adopt(device.client);
    expect(device.asked).toEqual([]);
    expect(device.session.has(TOKEN_KEY)).toBe(false);

    for (const [host, answer] of [
      ["127.0.0.1", null],
      ["devbox.tail1234.ts.net", "older server"],
    ] as const) {
      const kept = page(host, answer);
      await adopt(kept.client);
      expect(kept.asked).toEqual([]);
      expect(kept.session.get(TOKEN_KEY)).toBe("launch-token");
    }
  });
});

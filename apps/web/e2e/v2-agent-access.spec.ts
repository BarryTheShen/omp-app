import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  type AccessRecord,
  accessChallengeSigningText,
  accessRecordSigningText,
  DEVICE_ACCESS_PATHS,
} from "@omp-app/contracts";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * Agent access (#20) on the real server: a computer enrolls with a one-time code from Settings → Devices and opens its
 * access link; the Agent access panel shows it, its switch as it says it, and what it runs, live, with a record whose
 * signature does not check out marked so; Turn off reaches the computer; Remove forgets it. The computer here is the
 * test itself, speaking the link's frames with keys of its own, as `omp-app-device` does. The server's https address is
 * a stand-in: machines sign it into their answers, and nothing connects to it.
 */
const SERVER_ADDRESS = "https://omp.example.test";
realTest.use({ serverEnv: { OMP_APP_DEVICE_ACCESS: "1", OMP_APP_REMOTE_ORIGIN: SERVER_ADDRESS } });

const raw = (key: KeyObject): Buffer =>
  Buffer.from(String(key.export({ format: "jwk" }).x), "base64url");
const sshString = (bytes: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/** A computer as the test plays it: enrolled, its link open, saying on, sending what it ran. */
interface Computer {
  readonly machineId: string;
  /** The frames the server sent it, by type. */
  readonly heard: string[];
  sendState(on: boolean): void;
  /** Says on, with the chats allowed to reach it: a computer that keeps chat grants. */
  sendGrants(threadIds: readonly string[]): void;
  sendRecord(record: Omit<AccessRecord, "machineId" | "signature">, forged?: boolean): void;
  close(): void;
}

async function enrollComputer(page: Page, alias: string): Promise<Computer> {
  // The one-time code, as a person reads it in Settings → Devices.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const devices = page.getByRole("region", { name: "Devices" });
  await devices.getByRole("button", { name: "Pair a new device" }).click();
  const shown = devices
    .getByRole("region", { name: "One-time code" })
    .getByText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  await expect(shown).toBeVisible();
  const code = (await shown.textContent()) ?? "";
  await page.keyboard.press("Escape");

  const identity = generateKeyPairSync("ed25519");
  const host = generateKeyPairSync("ed25519");
  const hostKey = `ssh-ed25519 ${Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(raw(host.publicKey))]).toString("base64")}`;
  const origin = new URL(page.url()).origin;
  const answer = await fetch(`${origin}${DEVICE_ACCESS_PATHS.enroll}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      alias,
      identityKey: raw(identity.publicKey).toString("base64url"),
      hostKey,
    }),
  });
  const enrolled = (await answer.json()) as { status: string; machineId?: string };
  expect(enrolled.status).toBe("enrolled");
  const machineId = enrolled.machineId ?? "";
  const signed = (text: string) =>
    sign(null, Buffer.from(text), identity.privateKey).toString("base64url");

  const heard: string[] = [];
  const link = new WebSocket(`${origin.replace(/^http/, "ws")}${DEVICE_ACCESS_PATHS.link}`);
  const send = (frame: object) => link.send(JSON.stringify(frame));
  let on = false;
  let grants: readonly string[] | undefined;
  const stateFrame = () => ({
    type: "state",
    state: on
      ? {
          on: true,
          until: new Date(Date.now() + 3_600_000).toISOString(),
          sessions: 0,
          sudoUntil: null,
        }
      : { on: false },
    reviewPending: false,
    ...(on ? { reach: ["the internet (via eth0)", "192.168.1.0/24, 3 machines (via eth0)"] } : {}),
    ...(grants === undefined ? {} : { grants }),
  });
  const authed = new Promise<void>((done, failed) => {
    link.addEventListener("error", () => failed(new Error("the access link failed")));
    link.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; nonce?: string; n?: number };
      heard.push(frame.type);
      if (frame.type === "challenge") {
        send({
          type: "auth",
          machineId,
          signature: signed(
            accessChallengeSigningText(machineId, frame.nonce ?? "", SERVER_ADDRESS),
          ),
        });
        send(stateFrame());
        done();
      } else if (frame.type === "ping") send({ type: "pong", n: frame.n ?? 0 });
      // The computer obeys an off from any page.
      else if (frame.type === "off") {
        on = false;
        send(stateFrame());
      }
    });
  });
  await authed;
  return {
    machineId,
    heard,
    sendState(next) {
      on = next;
      send(stateFrame());
    },
    sendGrants(threadIds) {
      on = true;
      grants = threadIds;
      send(stateFrame());
    },
    sendRecord(fields, forged = false) {
      const record = { machineId, ...fields };
      const text = accessRecordSigningText(record);
      send({
        type: "record",
        record: { ...record, signature: signed(forged ? `${text} changed` : text) },
      });
    },
    close: () => link.close(),
  };
}

const ran = (seq: number, command: string, ended: boolean) => {
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  return {
    seq,
    stream: 1,
    kind: "command" as const,
    command,
    folder: "/home/omp-agent",
    startedAt,
    endedAt: ended ? new Date().toISOString() : null,
    exitCode: ended ? 0 : null,
    sudo: false,
  };
};

realTest.describe("new UI: agent access to your computers (#20)", () => {
  realTest.setTimeout(240_000);

  realTest(
    "an enrolled computer shows with its switch; what it runs shows live; an unverified record says so; Turn off reaches it; Remove forgets it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page.getByRole("button", { name: "Agent access", exact: true }).click();
      const panel = page
        .getByRole("complementary", { name: "Side panel" })
        .getByRole("tabpanel", { name: "Agent access" });
      await expect(panel.getByText("No computers are linked.", { exact: false })).toBeVisible();

      const computer = await enrollComputer(page, "laptop");
      try {
        const computers = panel.getByRole("list", { name: "Computers" });
        await expect(computers.getByText("laptop", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expect(computers.getByText(/^Off · /)).toBeVisible();
        // On: no button turns it on in a page; Turn off is offered.
        computer.sendState(true);
        await expect(
          computers.getByText(
            /^On · (59 min|1 h) left · until \d{1,2}:\d\d( [AP]M)? · 0 sessions$/,
          ),
        ).toBeVisible();
        await expect(panel.getByRole("button", { name: /turn on/i })).toHaveCount(0);
        // What access opens, as the computer reads it.
        await expect(
          computers.getByText(
            "Reachable from this computer: the internet (via eth0); 192.168.1.0/24, 3 machines (via eth0)",
          ),
        ).toBeVisible();

        // What it runs, live: the start, then the same record finished.
        computer.sendRecord(ran(1, "ls -la", false));
        const feed = panel.getByRole("list", { name: "What ran" });
        await expect(feed.getByText("ls -la", { exact: true })).toBeVisible();
        await expect(feed.getByText(/· running · not from a chat$/)).toBeVisible();
        computer.sendRecord(ran(1, "ls -la", true));
        await expect(feed.getByText(/· exit code 0 · 2 s · not from a chat$/)).toBeVisible();
        await expect(feed.getByRole("listitem")).toHaveCount(1);
        // A record whose signature does not check out is shown, marked.
        computer.sendRecord(ran(2, "cat /etc/hostname", true), true);
        await expect(
          feed
            .getByRole("listitem")
            .filter({ hasText: "cat /etc/hostname" })
            .getByText("The computer's signature could not be verified", { exact: false }),
        ).toBeVisible();
        await expect(
          feed
            .getByRole("listitem")
            .filter({ hasText: "ls -la" })
            .getByText(/could not be verified/),
        ).toHaveCount(0);

        // Its history, kept by the server.
        await panel.getByRole("button", { name: "laptop: what ran" }).click();
        const history = panel.getByRole("list", { name: "What ran on laptop" });
        await expect(history.getByText("ls -la", { exact: true })).toBeVisible();

        // Turn off: the server tells the computer, which turns off.
        await panel.getByRole("button", { name: "Turn off" }).click();
        await expect.poll(() => computer.heard.includes("off")).toBe(true);
        await expect(computers.getByText(/^Off · last connected /)).toBeVisible();

        // Remove asks in a row of its own: a double click on Remove forgets nothing.
        await panel.getByRole("button", { name: "Remove", exact: true }).dblclick();
        await expect(computers.getByText("laptop", { exact: true })).toBeVisible();
        await panel.getByRole("button", { name: "Remove", exact: true }).click();
        await panel.getByRole("button", { name: "Cancel" }).click();
        await expect(panel.getByRole("group", { name: "Remove laptop?" })).toBeHidden();
        await panel.getByRole("button", { name: "Remove", exact: true }).click();
        await panel.getByRole("button", { name: "Remove laptop" }).click();
        await expect(
          panel.getByText("laptop was removed from this server; its keys no longer work."),
        ).toBeVisible();
        await expect(panel.getByText("No computers are linked.", { exact: false })).toBeVisible();
      } finally {
        computer.close();
      }
    },
  );

  realTest(
    "on a phone the panel is a tab of the chat's details: it fits the width and its buttons are full-size targets",
    async ({ realApp, browser }) => {
      // Enrolled from a desktop page (Settings → Devices), looked at on the phone.
      const desktop = await realApp.open({ path: "/" });
      const computer = await enrollComputer(desktop, "build-server");
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
        timeout: 120_000,
      });
      try {
        computer.sendState(true);
        await page.getByRole("button", { name: "Details" }).click();
        await page.getByRole("tab", { name: "Agent access" }).click();
        const panel: Locator = page.getByRole("tabpanel", { name: "Agent access" });
        const turnOff = panel.getByRole("button", { name: "Turn off" });
        await expect(turnOff).toBeVisible({ timeout: 30_000 });
        expect((await turnOff.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        // The feed shows what runs while the panel is open.
        computer.sendRecord(
          ran(
            1,
            "cargo build --release --target x86_64-unknown-linux-gnu --features with-a-long-list-of-features",
            true,
          ),
        );
        await expect(panel.getByText("cargo build", { exact: false })).toBeVisible();
        // Nothing wider than the phone: a long command wraps.
        const sizes = await panel.evaluate((element) => [element.scrollWidth, element.clientWidth]);
        expect(sizes[0]).toBeLessThanOrEqual(sizes[1] ?? 0);
        await page.screenshot({ path: realTest.info().outputPath("agent-access-phone.png") });
      } finally {
        computer.close();
        await context.close();
      }
    },
  );

  realTest.describe("a chat waiting on the computer's owner", () => {
    realTest.use({ seedLongTurn: 2 });

    realTest(
      "the owner's answer reaches the chat as an Agent access notice, not as the person's message",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        const computer = await enrollComputer(page, "laptop");
        try {
          // The chats allowed when the link opens are no news; then the owner allows the seeded chat.
          computer.sendGrants([]);
          await page
            .getByRole("navigation", { name: "Chats" })
            .getByRole("button", { name: /^Run the long job/ })
            .click();
          const transcript = page.getByRole("region", { name: "Transcript" });
          await expect(transcript.getByText("All 2 steps are done.")).toBeVisible({
            timeout: 60_000,
          });
          computer.sendGrants(["01a11111-0000-7000-8000-000000000001"]);
          const notice = transcript.getByText(
            "laptop's owner allowed this chat to reach that computer",
            { exact: false },
          );
          await expect(notice).toBeVisible({ timeout: 90_000 });
          await expect(transcript.getByText("Agent access", { exact: true })).toBeVisible();
          // A notice, never a message bubble of the person's.
          await expect(
            transcript.locator(".tr-row--user", { hasText: "laptop's owner" }),
          ).toHaveCount(0);
          await page.screenshot({ path: realTest.info().outputPath("access-notice.png") });
        } finally {
          computer.close();
        }
        expect(realApp.problems).toEqual([]);
      },
    );
  });
});

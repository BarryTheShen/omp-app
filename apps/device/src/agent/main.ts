/**
 * `omp-app-device` (#20): the person's side of agent access on a machine.
 *
 *   omp-app-device run                      the agent (its user service starts it)
 *   omp-app-device enroll <server> <alias>  enroll this machine; asks the one-time pairing code made on the server
 *   omp-app-device on [--for <minutes>]     turn access on (default 120); asks your password
 *   omp-app-device off                      turn access off: every session ends
 *   omp-app-device status                   on or off, until when, what changed last time
 *   omp-app-device acknowledge              you looked at what changed during the last access; asks your password
 *   omp-app-device extend [--for <minutes>] more time while on (default 60; never past eight hours from now); asks your password
 *   omp-app-device sudo [--for <minutes>]   let the agent account use sudo while on (default 30, at most 30)
 *   omp-app-device watch                    what each session shows, live
 *   omp-app-device allow-folder <id> [--write]  allow an agent's folder request (status lists them); asks your password
 *   omp-app-device deny-folder <id>         turn a folder request down
 *   omp-app-device remove-folder <path>     stop sharing a folder (status lists them)
 *   omp-app-device allow-chat <chat id>     allow a chat that asked to reach this computer (status lists them); asks your password
 *   omp-app-device deny-chat <chat id>      turn a chat's request down
 *   omp-app-device remove-chat <chat id>    take a chat's access away
 */
import { existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { LONGEST_ON_MINUTES } from "../guard/guard";
import { Agent } from "./agent";
import { serveControl } from "./control";
import { guardRequest } from "./guard-client";
import { watchLock } from "./lock-watch";
import { safeLine, safeTerminalOutput } from "./safe-text";

const env = process.env;
const home = env.HOME ?? "";
const dataDir = join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "omp-app-device");
const runtimeDir = join(env.XDG_RUNTIME_DIR ?? join(dataDir, "run"), "omp-app-device");
const guardSocket = env.OMP_APP_DEVICE_GUARD ?? "/run/omp-app-device/control.sock";
const controlSocket = join(runtimeDir, "agent.sock");
const [command = "", ...args] = process.argv.slice(2);

/** Asks the running agent; prints its answer, returns its exit code. */
async function ask(request: object): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let text = "";
  try {
    const socket = await Bun.connect({
      unix: controlSocket,
      socket: {
        data(_socket, chunk) {
          text += new TextDecoder().decode(chunk);
        },
        close() {
          resolve(text);
        },
      },
    });
    socket.write(`${JSON.stringify(request)}\n`);
  } catch {
    process.stderr.write("The agent is not running (systemctl --user start omp-app-device).\n");
    return 1;
  }
  const line = (await promise).split("\n")[0] ?? "";
  if (line.startsWith("ok")) {
    console.log(line === "ok" ? "Done." : JSON.stringify(JSON.parse(line.slice(3)), null, 2));
    return 0;
  }
  process.stderr.write(`${line.replace(/^error /, "")}\n`);
  return 1;
}

/**
 * polkit asks the password in this terminal while `body` runs, when no desktop agent answers for this process. Without
 * polkit's terminal agent (a server image without `polkitd`) nothing could ask it, so nothing is asked of the guard.
 * The guard is asked only once the terminal agent is registered (`--notify-fd`): asked earlier, polkit finds nobody to
 * ask the password and says no at once.
 */
async function withTerminalPassword(body: () => Promise<number>): Promise<number> {
  const pkttyagent = Bun.which("pkttyagent");
  if (pkttyagent === null) {
    process.stderr.write(
      "polkit is not installed, so your password cannot be asked: sudo apt install polkitd\n",
    );
    return 1;
  }
  const agent = Bun.spawn(
    [pkttyagent, "--process", String(process.pid), "--fallback", "--notify-fd", "3"],
    { stdio: ["inherit", "inherit", "inherit", "pipe"] },
  );
  // pkttyagent closes fd 3 when it is registered (or ends, when another agent already answers for this process).
  const registered = agent.stdio[3];
  if (typeof registered === "number") {
    const closed = (async () => {
      for await (const _ of Bun.file(registered).stream()) {
        // Nothing is written: the end of the stream is the news.
      }
    })();
    await Promise.race([closed, agent.exited, Bun.sleep(10_000)]);
  }
  try {
    return await body();
  } finally {
    agent.kill();
  }
}

switch (command) {
  case "run": {
    const agent = await Agent.open({
      dataDir,
      runtimeDir,
      guardSocket,
      log: (line) => console.log(line),
    });
    await agent.start();
    const stop = await serveControl(controlSocket, agent);
    // The person is away: the screen locked or the computer is going to sleep.
    const stopLock = watchLock(
      (event) => {
        if (!agent.state.on) return;
        console.log(
          `access turns off: ${event === "locked" ? "the screen locked" : "going to sleep"}`,
        );
        void agent.off();
      },
      (line) => console.log(line),
    );
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        stop();
        stopLock();
        void agent.off().finally(() => process.exit(0));
      });
    }
    // The program was replaced (an upgrade) or removed (the app uninstalled): off, then out. The exit is a failure, so
    // the service runs the new program after an upgrade; after an uninstall nothing is left to run.
    setInterval(() => {
      let exe = "";
      try {
        exe = readlinkSync("/proc/self/exe");
      } catch {
        return;
      }
      if (!exe.endsWith(" (deleted)")) return;
      console.log("this program was replaced or removed: access turns off, and the agent stops");
      stop();
      stopLock();
      void agent.off().finally(() => process.exit(1));
    }, 30_000);
    break;
  }
  // Used by `omp-app-device remove` (as the person): the server forgets this computer, and its link record goes.
  case "leave":
    process.exit(await ask({ op: "leave" }));
    break;
  case "enroll": {
    const [server = "", alias = ""] = args;
    if (server === "" || alias === "") {
      process.stderr.write("Use omp-app-device enroll <server address> <name for this machine>.\n");
      process.exit(2);
    }
    // Before the code is asked (agent.enroll checks again): enrolling while on is refused.
    const guard = await guardRequest(guardSocket, { op: "state" });
    if (guard.ok && (guard.body as { on?: unknown }).on === true) {
      process.stderr.write("turn agent access off first\n");
      process.exit(1);
    }
    process.stdout.write(
      "One-time pairing code (Settings → App → Devices → New code on the server): ",
    );
    let code = "";
    for await (const line of console) {
      code = line.trim();
      break;
    }
    // The running agent enrolls itself, so it needs no restart; without one, the files are written for its next start.
    if (existsSync(controlSocket)) {
      const done = await ask({ op: "enroll", server, code, alias });
      if (done === 0) console.log(`Enrolled as ${alias}.`);
      process.exit(done);
    }
    const agent = await Agent.open({ dataDir, runtimeDir, guardSocket });
    const refused = await agent.enroll(server, code, alias);
    if (refused !== null) {
      process.stderr.write(`${refused}\n`);
      process.exit(1);
    }
    console.log(
      `Enrolled as ${alias}. Start the agent: systemctl --user enable --now omp-app-device`,
    );
    process.exit(0);
    break;
  }
  case "on": {
    const at = args.indexOf("--for");
    const minutes = at === -1 ? 120 : Number(args[at + 1]);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > LONGEST_ON_MINUTES) {
      process.stderr.write(`--for takes minutes, 1 to ${LONGEST_ON_MINUTES}.\n`);
      process.exit(2);
    }
    process.exit(await withTerminalPassword(() => ask({ op: "on", pid: process.pid, minutes })));
    break;
  }
  case "off":
    process.exit(await ask({ op: "off" }));
    break;
  case "status":
    process.exit(await ask({ op: "status" }));
    break;
  case "acknowledge":
    process.exit(await withTerminalPassword(() => ask({ op: "acknowledge", pid: process.pid })));
    break;
  case "extend": {
    const at = args.indexOf("--for");
    const minutes = at === -1 ? 60 : Number(args[at + 1]);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > LONGEST_ON_MINUTES) {
      process.stderr.write(`--for takes minutes, 1 to ${LONGEST_ON_MINUTES}.\n`);
      process.exit(2);
    }
    process.exit(
      await withTerminalPassword(() => ask({ op: "extend", pid: process.pid, minutes })),
    );
    break;
  }
  case "sudo": {
    const at = args.indexOf("--for");
    const minutes = at === -1 ? 30 : Number(args[at + 1]);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
      process.stderr.write("--for takes minutes, 1 to 30.\n");
      process.exit(2);
    }
    process.exit(await withTerminalPassword(() => ask({ op: "sudo", pid: process.pid, minutes })));
    break;
  }
  case "allow-folder": {
    const id = args.find((arg) => !arg.startsWith("--")) ?? "";
    const write = args.includes("--write");
    process.exit(
      await withTerminalPassword(() => ask({ op: "allow-folder", pid: process.pid, id, write })),
    );
    break;
  }
  case "deny-folder":
    process.exit(await ask({ op: "deny-folder", id: args[0] ?? "" }));
    break;
  case "remove-folder":
    process.exit(await ask({ op: "remove-folder", path: args[0] ?? "" }));
    break;
  case "allow-chat":
    process.exit(
      await withTerminalPassword(() =>
        ask({ op: "allow-chat", pid: process.pid, threadId: args[0] ?? "" }),
      ),
    );
    break;
  case "deny-chat":
    process.exit(await ask({ op: "deny-chat", threadId: args[0] ?? "" }));
    break;
  case "remove-chat":
    process.exit(await ask({ op: "remove-chat", threadId: args[0] ?? "" }));
    break;
  case "watch": {
    let buffer = "";
    // A session's output as text (a character split across events is kept whole), with only its colours as escapes.
    const outputText = new TextDecoder();
    const clock = (iso: string) =>
      new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    /** The state as one line for the person; repeated only when it changes. */
    let lastState = "";
    const stateLine = (state: {
      on?: boolean;
      until?: string | null;
      sessions?: number;
      sudoUntil?: string | null;
    }) => {
      if (state.on !== true) return "Agent access is off.";
      const sessions = state.sessions ?? 0;
      return [
        `Agent access is on${typeof state.until === "string" ? ` until ${clock(state.until)}` : ""}`,
        `${sessions} ${sessions === 1 ? "session" : "sessions"} open`,
        ...(typeof state.sudoUntil === "string" ? [`sudo until ${clock(state.sudoUntil)}`] : []),
      ].join(" · ");
    };
    const show = (line: string) => {
      const event = JSON.parse(line) as {
        type: string;
        event?: { type: string; bytes?: string; command?: string };
        text?: string;
        state?: Parameters<typeof stateLine>[0];
      };
      if (
        event.type === "wrapper" &&
        event.event?.type === "output" &&
        event.event.bytes !== undefined
      ) {
        process.stdout.write(
          safeTerminalOutput(
            outputText.decode(Buffer.from(event.event.bytes, "base64"), { stream: true }),
          ),
        );
      } else if (event.type === "wrapper" && event.event?.type === "start") {
        process.stdout.write(`\n▶ ${safeLine(event.event.command ?? "")}\n`);
      } else if (event.type === "notice" && event.text !== undefined) {
        process.stdout.write(`\n● ${safeLine(event.text)}\n`);
      } else if (event.type === "state" && event.state !== undefined) {
        const text = stateLine(event.state);
        if (text !== lastState) process.stdout.write(`\n● ${text}\n`);
        lastState = text;
      }
    };
    const socket = await Bun.connect({
      unix: controlSocket,
      socket: {
        data(_socket, chunk) {
          buffer += new TextDecoder().decode(chunk);
          for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            if (line !== "") show(line);
          }
        },
        close() {
          process.exit(0);
        },
      },
    });
    socket.write(`${JSON.stringify({ op: "watch" })}\n`);
    break;
  }
  default:
    process.stderr.write(
      "Use omp-app-device run | enroll <server> <alias> | on [--for <minutes>] | off | status | acknowledge | extend [--for <minutes>] | sudo [--for <minutes>] | watch | allow-folder <id> [--write] | deny-folder <id> | remove-folder <path> | allow-chat <chat id> | deny-chat <chat id> | remove-chat <chat id>\nIn an agent session: omp-app-device ask-folder <folder> [--write] [--why <text>] asks the person for one of their folders (--help for more).\n",
    );
    process.exit(2);
}

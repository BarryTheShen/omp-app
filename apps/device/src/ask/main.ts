/**
 * `omp-app-device ask-folder <folder> [--write] [--why <text>]` (#20, PLAN §7d): run by an agent in its session on this
 * computer, it asks the person for one of their folders. The guard checks the folder and shows the person the request;
 * once they allow it with their password, the folder is reachable at the path printed whenever access is on. It waits
 * for the answer (up to 10 minutes), and exits 0 only when the folder may be used.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const USAGE = `Usage: omp-app-device ask-folder <folder> [--write] [--why <text>]

Asks the person for one of their folders, to read (or with --write, also to change) while agent access is on.
<folder> is a full path, or '~/...' in quotes for a folder in the person's home (not the agent account's).
Prints where the folder can be reached once the person allows it.`;

const args = process.argv.slice(2);
let folder: string | null = null;
let write = false;
let why = "";
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at] as string;
  if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (arg === "--write") write = true;
  else if (arg === "--why") {
    why = args[at + 1] ?? "";
    at += 1;
  } else if (folder === null && !arg.startsWith("--")) folder = arg;
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
if (folder === null) {
  console.error(USAGE);
  process.exit(2);
}

const stream = Number(process.env.OMP_ACCESS_STREAM ?? "0");
const records = process.env.OMP_ACCESS_RECORDS ?? "";
if (records === "" || !Number.isInteger(stream) || stream < 1) {
  console.error("ask-folder runs only in an agent access session on the computer.");
  process.exit(2);
}

const Answer = (text: string) => {
  try {
    return JSON.parse(text) as { answer?: string; at?: string; write?: boolean; reason?: string };
  } catch {
    return {};
  }
};

// '~' and '~/…' are the person's home, read by the guard: never this account's own.
const path =
  folder === "~" || folder.startsWith("~/") || folder.startsWith("/") ? folder : resolve(folder);
const reply = await new Promise<string>((done) => {
  let text = "";
  const waiting = setTimeout(
    () => console.error("Waiting for the person to answer on the computer (up to 10 minutes)…"),
    1_000,
  );
  Bun.connect({
    unix: records,
    socket: {
      open(socket) {
        socket.write(
          `${JSON.stringify({
            type: "ask-folder",
            stream,
            request: randomBytes(8).toString("hex"),
            path,
            write,
            why: why.slice(0, 300),
          })}\n`,
        );
      },
      data(_socket, chunk) {
        text += new TextDecoder().decode(chunk);
      },
      close() {
        clearTimeout(waiting);
        done(text.trim());
      },
    },
  }).catch(() => {
    clearTimeout(waiting);
    done("");
  });
});

const answer = Answer(reply);
switch (answer.answer) {
  case "allowed":
    console.log(answer.at);
    console.error(
      `Allowed: ${folder} is at ${answer.at} (${answer.write === true ? "read and change" : "read only"}), while agent access is on.`,
    );
    process.exit(0);
    break;
  case "denied":
    console.error(`The person did not allow ${folder}.`);
    process.exit(1);
    break;
  case "refused":
  case "no answer":
    console.error(`Not shared: ${(answer.reason ?? "no reason given").replace(/\.$/, "")}.`);
    process.exit(1);
    break;
  default:
    console.error("The guard did not answer: agent access may have turned off.");
    process.exit(1);
}

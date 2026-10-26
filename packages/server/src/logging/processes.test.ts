import { describe, expect, test } from "bun:test";
import { listProcesses, ompProcessLines } from "./report";

// `ps -eo pid,ppid,rss,etime,args` as it looked on the machine of the issue: the server (pid 500) started omp
// processes and chats in omp's RPC mode (omp's command line from source, the installed chat host); the rest are other
// programs, some of which only mention omp, omp-app or rpc-ui in their arguments.
const PS_OUTPUT = [
  "    PID    PPID     RSS     ELAPSED COMMAND",
  "    201     500  380000       02:00 omp --mode rpc-ui --model fake/fake-model",
  "    202     500  120000       03:00 bun /home/me/.bun/bin/omp --mode rpc-ui",
  "    203       1  380000       09:00 omp --mode rpc-ui",
  "    204     500   90000       01:00 node /home/me/projects/omp-app/node_modules/.bin/vite preview --port 6280",
  "    205     500   50000       01:00 python3 /tmp/runner.py --target omp-app",
  "    206     999   70000       05:00 /usr/bin/python3 /home/me/nightly-job.py omp-app",
  "    207     500    1000       00:01 ps -eo pid,ppid,rss,etime,args",
  "    208     500  150000       00:30 omp",
  "    209     500    4000       00:30 bash /home/me/projects/omp-app/.data/heavy.sh nice -n 10 bun run test",
  "    210     500  410000       01:30 bun /home/me/omp-app/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts --mode rpc-ui --model fake/fake-model",
  "    211     500  330000       01:30 /usr/lib/omp-app/chat-host --mode rpc-ui --resume /home/me/.omp/agent/sessions/chat.jsonl",
  "    213     500    2000       00:01 grep rpc-ui /home/me/.omp/agent/app/omp-app.log",
].join("\n");

/** The pids a `listProcesses` listing names (its header and any message line are skipped). */
async function listedPids(owner: number): Promise<number[]> {
  const listing = await listProcesses(owner);
  return listing
    .split("\n")
    .slice(1)
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid));
}

/** A process whose command name (argv[0]) is `name`; it prints `ready` once it is running under that name. */
function namedProcess(name: string) {
  return Bun.spawn(["bash", "-c", `exec -a ${name} sh -c 'echo ready; read line'`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
}

/**
 * Reads `stdout` until `done` accepts the text so far: the process has reached that point, so no timer is needed.
 * The predicate can wait for several outputs, whose order between processes is not fixed.
 */
async function untilOutput(
  stdout: ReadableStream<Uint8Array>,
  done: (text: string) => boolean,
): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text;
}

describe("the debug report's omp processes", () => {
  test("keeps the header and the omp processes and chats that the given pid started, and nothing else", () => {
    const rows = PS_OUTPUT.split("\n");

    const wanted = rows.filter((_, index) => [0, 1, 2, 8, 10, 11].includes(index));
    expect(ompProcessLines(PS_OUTPUT, 500)).toEqual(wanted);
  });

  test("lists only the header when the given pid started no omp process", () => {
    const rows = PS_OUTPUT.split("\n");

    expect(ompProcessLines(PS_OUTPUT, 4242)).toEqual(rows.filter((_, index) => index === 0));
  });

  test("says so when no server is running", async () => {
    expect(await listProcesses(undefined)).toBe(
      "(no omp-app server is running, so no omp process is listed)",
    );
  });

  test("lists a real omp-named child of this process, and not another child", async () => {
    const omp = namedProcess("omp");
    const other = namedProcess("not-omp");
    try {
      await untilOutput(omp.stdout, (text) => text.includes("ready"));
      await untilOutput(other.stdout, (text) => text.includes("ready"));

      const pids = await listedPids(process.pid);
      expect(pids).toContain(omp.pid);
      expect(pids).not.toContain(other.pid);
    } finally {
      omp.kill();
      other.kill();
    }
  });

  test("does not list an omp process that another process started", async () => {
    const omp = namedProcess("omp");
    try {
      await untilOutput(omp.stdout, (text) => text.includes("ready"));
      // The child is alive and listed for its own parent (this test process), so the check below is not empty.
      expect(await listedPids(process.pid)).toContain(omp.pid);
      // The process that started this test run did not start the child, so its listing leaves the child out.
      expect(await listedPids(process.ppid)).not.toContain(omp.pid);
    } finally {
      omp.kill();
    }
  });
});

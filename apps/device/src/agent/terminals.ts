/**
 * A line on every terminal the person has open on this machine (#20), as `write` would put it: on a machine without a
 * desktop, this is how a new agent session is seen. Only the person's own terminals, which the agent (running as the
 * person) may write to.
 */
import { appendFile, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { safeLine } from "./safe-text";

export async function tellTerminals(text: string): Promise<number> {
  const me = userInfo();
  const who = Bun.spawnSync(["who"]).stdout.toString();
  let told = 0;
  for (const line of who.split("\n")) {
    const [user, tty] = line.trim().split(/\s+/);
    if (user !== me.username || tty === undefined || !/^(pts\/\d+|tty\d+)$/.test(tty)) continue;
    const path = `/dev/${tty}`;
    try {
      if ((await stat(path)).uid !== me.uid) continue;
      // The text holds a session's command line: one plain line, no escapes a terminal would act on.
      await appendFile(path, `\r\n${safeLine(text)}\r\n`);
      told += 1;
    } catch {
      // A terminal that closed meanwhile.
    }
  }
  return told;
}

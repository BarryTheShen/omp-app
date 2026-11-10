import { describe, expect, test } from "bun:test";
import { tuiCommands, tuiEnvironment, tuiSessionName } from "./tui";

describe("tuiSessionName", () => {
  test("names one session per folder, the same each time, and two folders with one name apart", () => {
    const name = tuiSessionName("/home/user/work/app");
    expect(name).toMatch(/^omp-app-app-[0-9a-f]{8}$/);
    expect(tuiSessionName("/home/user/work/app")).toBe(name);
    expect(tuiSessionName("/home/user/other/app")).not.toBe(name);
  });

  test("keeps out the characters tmux reads in a target, and names the root folder too", () => {
    // tmux turns "." and ":" in a session name into "_", and reads them as window and pane in a target.
    expect(tuiSessionName("/srv/my.site:v2 (old)")).toMatch(/^omp-app-my-site-v2-old-[0-9a-f]{8}$/);
    expect(tuiSessionName("/")).toMatch(/^omp-app-folder-[0-9a-f]{8}$/);
  });
});

describe("tuiEnvironment", () => {
  test("passes the chats' search path and where omp keeps its chats, and no keys", () => {
    expect(
      tuiEnvironment(
        {
          HOME: "/home/user",
          PATH: "/usr/bin",
          PI_CODING_AGENT_DIR: "/data/agent",
          XDG_STATE_HOME: "",
          ANTHROPIC_API_KEY: "sk-secret",
          TMUX: "/tmp/tmux-1000/default,1,0",
        },
        "/usr/bin:/home/user/.bun/bin",
      ),
    ).toEqual({
      PATH: "/usr/bin:/home/user/.bun/bin",
      HOME: "/home/user",
      PI_CODING_AGENT_DIR: "/data/agent",
    });
  });
});

describe("tuiCommands", () => {
  const base = {
    tmux: "/usr/bin/tmux",
    folder: "/home/user/work/app",
    omp: ["/usr/lib/omp-app/chat-host"],
    ompArgs: ["--resume", "abc123"],
    settingsFile: "/home/user/.omp/app/tui-settings.yml",
    env: { PATH: "/usr/bin", HOME: "/home/user" },
  };
  const name = tuiSessionName(base.folder);
  const program = [
    "env",
    "PATH=/usr/bin",
    "HOME=/home/user",
    "/usr/lib/omp-app/chat-host",
    // The app's settings first, so a `--config` of the user's own after `--` still applies.
    "--config",
    "/home/user/.omp/app/tui-settings.yml",
    "--resume",
    "abc123",
  ];

  test("outside tmux, starts the folder's session in the folder, or attaches to it when it runs", () => {
    const start = [[base.tmux, "new-session", "-A", "-s", name, "-c", base.folder, ...program]];
    expect(tuiCommands({ ...base, insideTmux: false, running: false })).toEqual(start);
    // tmux's -A attaches to a running session and ignores the command, so a race with its end still opens omp.
    expect(tuiCommands({ ...base, insideTmux: false, running: true })).toEqual(start);
  });

  test("inside tmux, starts the session detached when it does not run, then switches to it", () => {
    const switchTo = [base.tmux, "switch-client", "-t", `=${name}`];
    expect(tuiCommands({ ...base, insideTmux: true, running: false })).toEqual([
      [base.tmux, "new-session", "-d", "-s", name, "-c", base.folder, ...program],
      switchTo,
    ]);
    expect(tuiCommands({ ...base, insideTmux: true, running: true })).toEqual([switchTo]);
  });
});

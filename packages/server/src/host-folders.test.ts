import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostFilesNote, hostFilesOf } from "./chat-host/host-files";
import {
  ensureHostFolder,
  HostFolderRefused,
  hostFilesArguments,
  projectFolderName,
} from "./host-folders";

describe("host folders", () => {
  test("a project's name as a folder name; two projects of one name stay apart by their id", async () => {
    expect(projectFolderName("My App (2)")).toBe("my-app-2");
    expect(projectFolderName("../../etc")).toBe("etc");
    expect(projectFolderName("...")).toBe("project");
    const appData = await mkdtemp(join(tmpdir(), "host-folders-"));
    try {
      const one = await ensureHostFolder(appData, "vscode", "web", "aaaaaaaaaaaaaaaa");
      const two = await ensureHostFolder(appData, "vscode", "web", "bbbbbbbbbbbbbbbb");
      expect(one).toBe(join(appData, "host-folders", "vscode", "web-aaaaaaaaaaaa"));
      expect(two).not.toBe(one);
      await expect(ensureHostFolder(appData, "VS Code", "web", "aaaaaaaa")).rejects.toBeInstanceOf(
        HostFolderRefused,
      );
      await expect(ensureHostFolder(appData, "vscode", "web", "not-hex!")).rejects.toBeInstanceOf(
        HostFolderRefused,
      );
    } finally {
      await rm(appData, { recursive: true, force: true });
    }
  });

  test("a chat in a host folder starts with the host's flag; any other folder, a deeper or a shallower one, without", () => {
    const appData = "/data/app";
    expect(hostFilesArguments("/data/app/host-folders/vscode/web-aaaaaaaaaaaa", appData)).toEqual([
      "--app-host-files=vscode",
    ]);
    expect(hostFilesArguments("/data/app/host-folders/vscode/web-aaaaaaaaaaaa/", appData)).toEqual([
      "--app-host-files=vscode",
    ]);
    for (const folder of [
      "/home/someone/project",
      "/data/app/host-folders/vscode",
      "/data/app/host-folders/vscode/web-aaaaaaaaaaaa/src",
      "/data/app/host-folders/../host-folders2/vscode/web",
      "/data/app/host-folders/Bad Host/web",
    ])
      expect(hostFilesArguments(folder, appData)).toEqual([]);
  });

  test("the chat host takes its flag out of omp's arguments wherever it is, and ignores one that names no host", () => {
    expect(
      hostFilesOf(["--model", "fake/fake-model", "--app-host-files=vscode", "--resume", "x"]),
    ).toEqual({ host: "vscode", rest: ["--model", "fake/fake-model", "--resume", "x"] });
    expect(hostFilesOf(["--app-host-files=../x", "--continue"])).toEqual({
      host: undefined,
      rest: ["--continue"],
    });
    expect(hostFilesOf(["--continue"])).toEqual({ host: undefined, rest: ["--continue"] });
    expect(hostFilesNote("vscode")).toContain("open in VS Code there");
    expect(hostFilesNote("vscode")).toContain("their names start with `vscode_`");
  });
});

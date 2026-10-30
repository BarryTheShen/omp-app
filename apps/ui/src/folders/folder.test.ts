import { FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { folderName, homeOf, shownFolder, typedFolder } from "./folder";

const path = (text: string): FolderPath => FolderPath.parse(text);
const home = path("/home/me");

describe("folders", () => {
  test("a typed path opens that folder, without its trailing separator; ~ is the home folder once it is known", () => {
    expect(typedFolder("  /srv/project/ ", home)).toEqual({ ok: true, folder: "/srv/project" });
    expect(typedFolder("~/code/app", home)).toEqual({ ok: true, folder: "/home/me/code/app" });
    expect(typedFolder("~", home)).toEqual({ ok: true, folder: "/home/me" });
    expect(typedFolder("~/code", null)).toEqual({
      ok: false,
      message: "~ is not known here. Type the full path, for example /home/you/project.",
    });
  });

  test("an empty or relative path says what to type instead", () => {
    expect(typedFolder("   ", home)).toEqual({ ok: false, message: "Type a folder path." });
    expect(typedFolder("code/app", home)).toEqual({
      ok: false,
      message: "Type the full path to the folder, for example /home/you/project.",
    });
    // `~user` is another person's home, which the app cannot know.
    expect(typedFolder("~other/app", home).ok).toBe(false);
  });

  test("the sidebar names a folder by its last part, and the home folder ~", () => {
    expect(folderName(path("/home/me/code"), home)).toBe("code");
    expect(folderName(home, home)).toBe("~");
    expect(folderName(path("/"), home)).toBe("/");
  });

  test("a folder inside the home folder shows from ~; one outside, or with the home unknown, in full", () => {
    expect(shownFolder(path("/home/me/code/app"), home)).toBe("~/code/app");
    expect(shownFolder(home, home)).toBe("~");
    expect(shownFolder(path("/home/meow/app"), home)).toBe("/home/meow/app");
    expect(shownFolder(path("/srv/app"), home)).toBe("/srv/app");
    expect(shownFolder(path("/home/me/app"), null)).toBe("/home/me/app");
  });

  test("the home folder follows from how the server shows a folder", () => {
    expect(homeOf(path("/home/me/code"), "~/code")).toBe("/home/me");
    expect(homeOf(path("/home/me"), "~")).toBe("/home/me");
    expect(homeOf(path("/srv/app"), "/srv/app")).toBeNull();
    // Shown through a link to elsewhere: the tail does not match, so the home stays unknown.
    expect(homeOf(path("/data/me/code"), "~/elsewhere")).toBeNull();
  });
});

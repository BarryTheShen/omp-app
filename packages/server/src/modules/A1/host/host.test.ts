import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppFailure, HostMetadata } from "@omp-app/contracts";
import { readHostMetadata } from "./index";

const dataRoot = resolve(import.meta.dir, "../../../../../../.data");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("readHostMetadata", () => {
  test("replaces the home directory with a tilde and keeps the first hostname component", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const folder = join(home, "projects", "omp-app");
    await mkdir(folder, { recursive: true });

    const result = await readHostMetadata(folder, {
      homeDir: home,
      hostname: "builder.example.invalid",
    });

    expect(HostMetadata.parse(result)).toEqual(result);
    expect(result).toEqual({ hostname: "builder", displayPath: "~/projects/omp-app" });
  });

  test("displays the home directory itself as a tilde", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    await mkdir(home, { recursive: true });

    const result = await readHostMetadata(home, { homeDir: home, hostname: "host" });

    expect(result.displayPath).toBe("~");
  });

  test("keeps a folder outside the home directory absolute", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const outside = join(root, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(outside, { recursive: true });

    const result = await readHostMetadata(outside, { homeDir: home, hostname: "host.local" });

    expect(result.displayPath).toBe(outside);
    expect(result.displayPath).not.toContain("~");
    expect(result.hostname).toBe("host");
  });
  test("does not make a home symlink to an outside folder look home-relative", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const outside = join(root, "outside");
    await mkdir(home, { recursive: true });
    await mkdir(outside, { recursive: true });
    const linked = join(home, "linked");
    await symlink(outside, linked);

    const result = await readHostMetadata(linked, { homeDir: home, hostname: "host" });

    expect(result.displayPath).toBe(outside);
  });
  test("reports a missing folder as not_found", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const missing = join(home, "missing");
    await mkdir(home, { recursive: true });

    const error = await readHostMetadata(missing, { homeDir: home }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("not_found");
    expect((error as AppFailure).appError.message).toBe(
      "That folder doesn't exist. Check the path.",
    );
  });

  test("rejects a path that exists but is not a folder", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const file = join(home, "file.txt");
    await mkdir(home, { recursive: true });
    await Bun.write(file, "content");

    const error = await readHostMetadata(file, { homeDir: home }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("invalid_args");
    expect((error as AppFailure).appError.message).toBe(
      "That path isn't a folder. Check the path.",
    );
  });

  test("asks for a path that starts with /, in plain words, for a relative or Windows drive path", async () => {
    for (const path of ["relative/folder", "C:\\Users\\me\\project"]) {
      const error = await readHostMetadata(path, { homeDir: dataRoot }).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(AppFailure);
      expect((error as AppFailure).appError.code).toBe("invalid_args");
      expect((error as AppFailure).appError.message).toBe(
        "Enter a folder path that starts with /.",
      );
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "says a folder that cannot be read is a permission problem, in plain words",
    async () => {
      const root = await temporaryDirectory();
      const locked = join(root, "locked");
      const child = join(locked, "child");
      await mkdir(child, { recursive: true });
      await chmod(locked, 0o000);
      try {
        const error = await readHostMetadata(child, { homeDir: root }).catch(
          (cause: unknown) => cause,
        );
        expect(error).toBeInstanceOf(AppFailure);
        expect((error as AppFailure).appError.code).toBe("permission");
        expect((error as AppFailure).appError.message).toBe(
          "You don't have permission to open that folder.",
        );
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  test("says any other failure to open a folder, in plain words", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "file.txt");
    await Bun.write(file, "content");
    const error = await readHostMetadata(join(file, "inside"), { homeDir: root }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("internal");
    expect((error as AppFailure).appError.message).toBe("That folder couldn't be opened.");
  });
});

async function temporaryDirectory(): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const path = await mkdtemp(join(dataRoot, "a1-host-"));
  temporaryRoots.push(path);
  return path;
}

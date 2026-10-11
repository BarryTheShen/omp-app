import { describe, expect, test } from "bun:test";
import { FileWatchRegistry } from "../../modules/A1/fs";
import { currentHealth } from "./app";

describe("the health the page reads", () => {
  test("is degraded, with the plain message and its code, while a watched file cannot be watched", () => {
    const fileWatch = new FileWatchRegistry();
    fileWatch.fail({}, "/app/config.yml", { code: "ENOSPC" });
    expect(currentHealth({ health: { status: "ok" }, fileWatch })).toMatchObject({
      status: "degraded",
      code: "watch_limited",
    });
  });

  test("is ok once every watch is open", () => {
    expect(currentHealth({ health: { status: "ok" }, fileWatch: new FileWatchRegistry() })).toEqual(
      { status: "ok" },
    );
  });

  test("keeps a start-up problem over a watch problem, since omp cannot be used then", () => {
    const fileWatch = new FileWatchRegistry();
    fileWatch.fail({}, "/app/config.yml", { code: "ENOSPC" });
    const unhealthy = { status: "unhealthy" as const, detail: "omp was not found." };
    expect(currentHealth({ health: unhealthy, fileWatch })).toEqual(unhealthy);
  });

  test("without a registry, the start-up health is what the page reads", () => {
    expect(currentHealth({ health: { status: "ok" } })).toEqual({ status: "ok" });
  });
});

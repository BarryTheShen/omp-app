/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { INVENTORY } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { AP6_UNAVAILABLE_REASONS, D8_AP6_CAPABILITIES } from "../contract";
import { D8_DESCRIPTORS, D8_GOAL_OPERATION_CAPABILITY } from "../descriptors";
import { D8_OWNED_ROWS } from "./owned-rows";

/** The D8 folder. Vitest runs from apps/web, as the other gate tests assume. */
const D8_DIR = resolve(process.cwd(), "src/modules/D8");
const AP6_SEAMS: readonly string[] = Object.values(D8_AP6_CAPABILITIES);

/** The capability each terminal-only row needs, as its descriptor states it. Exact, so a wrong key fails the test. */
const TERMINAL_ONLY_CLOSURE: Readonly<Record<string, readonly string[]>> = {
  "C3.goal-show": ["omp.cmd.goal"],
  "C3.goal-pause": ["omp.cmd.goal"],
  "C3.goal-resume": ["omp.cmd.goal"],
  "C3.goal-drop": ["omp.cmd.goal"],
  "C3.guided-goal": ["omp.cmd.goal"],
  "C3.guided-goal-interview": ["omp.cmd.goal"],
  "C3.goal-set": [D8_AP6_CAPABILITIES.goalUpdate],
  "C3.goal-budget": [D8_AP6_CAPABILITIES.goalUpdate],
  "C3.goal-launch-flag": [D8_AP6_CAPABILITIES.goalLaunch],
  "C3.loop": [D8_AP6_CAPABILITIES.loop],
  "C3.loop-mode": [D8_AP6_CAPABILITIES.loop],
  "C3.tan": [D8_AP6_CAPABILITIES.tanDispatch],
  "C3.vibe": [D8_AP6_CAPABILITIES.vibeWorker],
  "C3.vibe-mode": [D8_AP6_CAPABILITIES.vibeWorker],
};

/** A prompt or steer sent to omp: the prompt command in any of its forms, or a `.prompt(` call. */
const PROMPT_SENT =
  /type:\s*["'](prompt|steer|follow_up|abort_and_prompt)["']|omp\.cmd\.prompt|\.prompt\(/;

/** A timer: a loop driven by a timer is the fake loop the spec forbids. Either form counts. */
const TIMER = /setInterval|setTimeout/;

/** D8's production sources: every .ts and .tsx file outside the tests, the test folder and the playgrounds. */
function productionSources(dir: string = D8_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : productionSources(path);
    const isSource = /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name);
    return isSource && !entry.name.includes("playground") ? [path] : [];
  });
}

/** The requires list of the one descriptor that covers this inventory row. */
function requiresOfRow(row: string): readonly string[] {
  const descriptor = D8_DESCRIPTORS.find((item) => {
    const covers: readonly string[] = item.covers;
    return covers.includes(row);
  });
  if (descriptor === undefined) throw new Error(`no D8 descriptor covers ${row}`);
  const requires: readonly string[] = descriptor.requires;
  return requires;
}

describe("CC12: every D8 row has one owner, and every terminal-only gap has a closure", () => {
  test("each of the 14 terminal-only rows needs exactly the closure its entry names", () => {
    const terminalOnly = INVENTORY.filter(
      (item) => D8_OWNED_ROWS.includes(item.id) && item.rpc === "terminal-only",
    ).map((item) => item.id);
    expect([...terminalOnly].sort()).toEqual(Object.keys(TERMINAL_ONLY_CLOSURE).sort());
    for (const row of terminalOnly) {
      expect(requiresOfRow(row)).toEqual(TERMINAL_ONLY_CLOSURE[row]);
    }
  });

  test("the released goal operations all go through the goal command", () => {
    expect([...new Set(Object.values(D8_GOAL_OPERATION_CAPABILITY))]).toEqual(["omp.cmd.goal"]);
  });

  test("every AP6 seam has a reason and at least one descriptor that needs it", () => {
    expect(Object.keys(AP6_UNAVAILABLE_REASONS).sort()).toEqual(
      Object.keys(D8_AP6_CAPABILITIES).sort(),
    );
    expect(Object.values(AP6_UNAVAILABLE_REASONS).every((reason) => reason.trim() !== "")).toBe(
      true,
    );
    for (const seam of AP6_SEAMS) {
      const needed = D8_DESCRIPTORS.some((descriptor) =>
        descriptor.requires.some((key) => key === seam),
      );
      expect(needed).toBe(true);
    }
  });

  test("D8 registers 20 descriptors over the 18 owned rows", () => {
    expect(D8_DESCRIPTORS).toHaveLength(20);
    expect(D8_OWNED_ROWS).toHaveLength(18);
  });

  test("no D8 production source sends a prompt, so no autonomy feature falls back to one", () => {
    const sends = productionSources().filter((file) =>
      PROMPT_SENT.test(readFileSync(file, "utf8")),
    );
    expect(sends.map((file) => relative(D8_DIR, file))).toEqual([]);
  });

  test("no loop or guided-interview source runs a timer", () => {
    const timed = productionSources().filter(
      (file) => /\/(loop|guided)\//.test(file) && TIMER.test(readFileSync(file, "utf8")),
    );
    expect(timed.map((file) => relative(D8_DIR, file))).toEqual([]);
  });
});

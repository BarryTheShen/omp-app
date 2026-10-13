import { describe, expect, test } from "vitest";
import { SlashCommand } from "../contract";
import { routeSlashText, type SlashAppCommand } from "./routing";
import { REAL_COMMAND_LIST } from "./test-support";

const entries = REAL_COMMAND_LIST.map((raw) => SlashCommand.parse(raw));
const noArguments: SlashAppCommand = {
  name: "usage",
  description: "Show provider usage",
  run: async () => ({ message: "Usage shown." }),
};
const withArguments: SlashAppCommand = {
  name: "goal",
  description: "Show, set, pause, resume or drop the goal",
  takesArguments: true,
  run: async () => ({}),
};

describe("#1261 bare command names keep their routes", () => {
  test("a bare app command name routes to the app with no arguments", () => {
    const route = routeSlashText("/usage", entries, [noArguments]);
    expect(route).toEqual({ kind: "app", command: noArguments });
    expect(route).not.toHaveProperty("args");
  });

  test("a command that takes no arguments is not the app's when text follows its name", () => {
    expect(routeSlashText("/usage show x", entries, [noArguments])).toEqual({
      kind: "omp",
      command: "/usage show x",
    });
    expect(routeSlashText("/usage show x", [], [noArguments])).toBeNull();
  });
});

describe("#1261 a command that takes arguments receives the text after its name", () => {
  test("the bare name routes with no args field, as a bare name always has", () => {
    const route = routeSlashText("/goal", entries, [withArguments]);
    expect(route).toEqual({ kind: "app", command: withArguments });
    expect(route).not.toHaveProperty("args");
  });

  test("text after the name arrives trimmed", () => {
    expect(routeSlashText("/goal   Ship the release notes  ", entries, [withArguments])).toEqual({
      kind: "app",
      command: withArguments,
      args: "Ship the release notes",
    });
  });

  test("a tab or a line break also ends the name", () => {
    expect(routeSlashText("/goal\tpause", entries, [withArguments])).toEqual({
      kind: "app",
      command: withArguments,
      args: "pause",
    });
    expect(routeSlashText("/goal\nresume", entries, [withArguments])).toEqual({
      kind: "app",
      command: withArguments,
      args: "resume",
    });
  });

  test("a longer word is a different command, not this one with arguments", () => {
    expect(routeSlashText("/goalkeeper now", entries, [withArguments])).toBeNull();
  });

  test("text that starts with a space is still a prompt", () => {
    expect(routeSlashText(" /goal pause", entries, [withArguments])).toBeNull();
  });
});

describe("#1273 a command that takes arguments takes them after a colon too, as omp reads it", () => {
  test("/goal:pause is /goal with the text pause, and a bare /goal: is the bare name", () => {
    expect(routeSlashText("/goal:pause", entries, [withArguments])).toEqual({
      kind: "app",
      command: withArguments,
      args: "pause",
    });
    expect(routeSlashText("/goal:", entries, [withArguments])).toEqual({
      kind: "app",
      command: withArguments,
    });
  });
});

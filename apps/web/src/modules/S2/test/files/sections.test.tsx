import type { ConfigEntry, FolderPath } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { SettingsRuntime } from "../../../S1/runtime";
import {
  FilesEditingSection,
  FilesReadingSection,
  FilesReadSummariesSection,
  type FilesSettingsSectionProps,
  useFilesSettingsController,
} from "../../files";
import { selectFilesReadSummariesPolicy } from "../../files/policy";
import {
  FILES_EDITING_SECTION,
  FILES_READ_SUMMARIES_SECTION,
  FILES_READING_SECTION,
} from "../../sections";
import { createFilesRuntime, defaultFilesEntries, publishFilesChange } from "./fixtures";

const runtimes: SettingsRuntime[] = [];
function FilesHarness({
  runtime,
  Section,
}: {
  readonly runtime: SettingsRuntime;
  readonly Section: ComponentType<FilesSettingsSectionProps>;
}) {
  const view = useFilesSettingsController(runtime);
  return <Section {...view} />;
}

afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe("S2.2 ConfigStore-backed Files sections", () => {
  test("reads Editing through ConfigStore and commits separate revision-checked keys", async () => {
    const { runtime, state } = createFilesRuntime(FILES_EDITING_SECTION);
    runtimes.push(runtime);
    render(<FilesHarness runtime={runtime} Section={FilesEditingSection} />);

    await screen.findByRole("heading", { name: "Files / Editing" });
    expect(screen.getByTestId("edit.mode-provenance").textContent).toContain("Source: default");
    expect(screen.getByRole("combobox")).toBeTruthy();

    expect(runtime.stage("edit.mode", { secret: false, value: "patch" }).ok).toBe(true);
    expect(runtime.stage("edit.fuzzyMatch", { secret: false, value: false }).ok).toBe(true);
    await runtime.save();

    expect(state.writes).toHaveLength(2);
    expect(state.writes.map(({ key, expectedRevision }) => [key, expectedRevision])).toEqual([
      ["edit.mode", "revision-1"],
      ["edit.fuzzyMatch", "revision-2"],
    ]);
    expect(runtime.getSnapshot().applyStatus).toBe("reload-required");
  });

  test("keeps invalid bounds local and never sends them to ConfigStore", async () => {
    const { runtime, state } = createFilesRuntime(FILES_EDITING_SECTION);
    runtimes.push(runtime);
    render(<FilesHarness runtime={runtime} Section={FilesEditingSection} />);
    await screen.findByRole("heading", { name: "Files / Editing" });

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1.2" } });
    expect(screen.getByRole("alert").textContent).toContain("Enter a number from 0 to 1.");
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(state.writes).toHaveLength(0);
  });

  test("shows Reading provenance and respects a project-scoped ConfigStore read", async () => {
    const projectFolder = "/workspace/files-reading" as FolderPath;
    const entries: ConfigEntry[] = defaultFilesEntries(FILES_READING_SECTION).map(
      (entry): ConfigEntry => {
        if (entry.secret) return entry;
        if (entry.key === "read.defaultLimit") {
          return {
            ...entry,
            value: 500,
            source: "project",
            overrides: ["global"] as ConfigEntry["overrides"],
          };
        }
        return entry;
      },
    );
    const { runtime } = createFilesRuntime(FILES_READING_SECTION, entries, {
      folder: projectFolder,
      layer: "project",
    });
    runtimes.push(runtime);
    render(<FilesHarness runtime={runtime} Section={FilesReadingSection} />);

    await screen.findByRole("heading", { name: "Files / Reading" });
    expect(runtime.getSnapshot().config?.folder).toBe(projectFolder);
    expect(screen.getByTestId("read.defaultLimit-provenance").textContent).toContain(
      "Source: project · overrides global",
    );
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("500");
  });

  test("read summaries keep stored dependent values visible but read-only when disabled", async () => {
    const projectFolder = "/workspace/read-summaries" as FolderPath;
    const entries: ConfigEntry[] = defaultFilesEntries(FILES_READ_SUMMARIES_SECTION).map(
      (entry): ConfigEntry => {
        if (entry.secret) return entry;
        const projectEntry = {
          ...entry,
          source: "project" as const,
          overrides: ["global"] as ConfigEntry["overrides"],
        };
        if (entry.key === "read.summarize.enabled") return { ...projectEntry, value: false };
        if (entry.key === "read.summarize.prose") return { ...projectEntry, value: true };
        return projectEntry;
      },
    );
    const { runtime } = createFilesRuntime(FILES_READ_SUMMARIES_SECTION, entries, {
      folder: projectFolder,
      layer: "project",
    });
    runtimes.push(runtime);
    render(<FilesHarness runtime={runtime} Section={FilesReadSummariesSection} />);

    await screen.findByRole("heading", { name: "Files / Read Summaries" });
    expect(screen.getAllByText("Turn on Read Summaries to edit this setting.")).toHaveLength(6);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.getByTestId("read.summarize.prose-provenance").textContent).toContain(
      "Source: project · overrides global",
    );
    const snapshot = runtime.getSnapshot().config;
    if (!snapshot) throw new Error("Read summaries were not loaded.");
    expect(selectFilesReadSummariesPolicy(snapshot).values).toMatchObject({
      enabled: false,
      prose: true,
    });

    runtime.stage("read.summarize.enabled", { secret: false, value: true });
    await waitFor(() => expect(screen.getAllByRole("spinbutton")).toHaveLength(5));
  });

  test("external changes show the new effective value before Keep mine and CAS retry", async () => {
    const { runtime, state } = createFilesRuntime(FILES_READING_SECTION);
    runtimes.push(runtime);
    render(<FilesHarness runtime={runtime} Section={FilesReadingSection} />);
    await screen.findByRole("heading", { name: "Files / Reading" });
    runtime.stage("read.defaultLimit", { secret: false, value: 500 });
    publishFilesChange(
      state,
      { key: "read.defaultLimit", secret: false, value: 200, source: "global", overrides: [] },
      "revision-external",
    );
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe("conflict"));
    expect(screen.getByRole("alert").textContent).toContain(
      "Default Read Limit: 200 · Source: global",
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe("ready"));
    expect(state.writes.map((write) => write.expectedRevision)).toEqual(["revision-external"]);
  });

  test("stale CAS saves reload the current value before another write", async () => {
    const { runtime, state } = createFilesRuntime(FILES_READING_SECTION);
    runtimes.push(runtime);
    await runtime.read();
    runtime.stage("read.defaultLimit", { secret: false, value: 500 });
    state.revision = "revision-external";

    await expect(runtime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(
      runtime
        .getSnapshot()
        .conflict?.remote.entries.find((entry) => entry.key === "read.defaultLimit"),
    ).toMatchObject({
      secret: false,
      value: 300,
    });
    runtime.resolveConflict("reload");
    expect(runtime.getSnapshot().staged?.edits).toEqual({});
    expect(state.writes[0]?.expectedRevision).toBe("revision-1");
  });

  test("read failures provide Retry and recover from the ConfigStore", async () => {
    const { runtime, state } = createFilesRuntime(FILES_EDITING_SECTION);
    runtimes.push(runtime);
    state.listError = new AppFailure({
      code: "permission",
      message: "The settings host is unavailable.",
      retryable: true,
    });
    render(<FilesHarness runtime={runtime} Section={FilesEditingSection} />);

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("The settings host is unavailable.");
    state.listError = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe("ready"));
    expect(screen.getByTestId("edit.mode-provenance").textContent).toContain("Source: default");
  });
  test("does not display a secret payload returned for a non-secret setting", async () => {
    const hiddenValue = ["not", "visible", "runtime"].join("-");
    const initial = defaultFilesEntries(FILES_READING_SECTION);
    const entries = initial.map((entry) =>
      entry.key === "read.defaultLimit"
        ? (Object.assign(
            {
              key: entry.key,
              secret: true,
              isSet: true,
              source: "env",
              overrides: [],
            },
            { value: hiddenValue },
          ) as unknown as ConfigEntry)
        : entry,
    );
    const { runtime } = createFilesRuntime(FILES_READING_SECTION, entries);
    runtimes.push(runtime);
    render(<FilesHarness runtime={runtime} Section={FilesReadingSection} />);

    await screen.findByRole("heading", { name: "Files / Reading" });
    expect(screen.getByTestId("read.defaultLimit-provenance").textContent).toContain("Source: env");
    expect(screen.queryByDisplayValue(hiddenValue)).toBeNull();
    expect(screen.queryByText(hiddenValue)).toBeNull();
  });
});

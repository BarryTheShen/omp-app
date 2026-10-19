import { AppFailure, type Rule } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost } from "@/overlay";
import type { RulesController } from "../../rules/controller";
import { RulesPanel } from "../../rules/panel";

function controller(
  overrides: Partial<RulesController["state"]> = {},
  rulesFile = false,
): RulesController {
  const rule = {
    id: (rulesFile ? "RULES.md" : "release.md") as Rule["id"],
    name: rulesFile ? "RULES.md" : "Release notes",
    scope: "project" as const,
    content: "Keep release notes factual.",
    enabled: true,
    source: "project" as const,
    revision: "r1",
  };
  return {
    state: {
      open: true,
      scope: "project",
      query: "",
      rules: [rule],
      selected: rule,
      draft: rule.content,
      draftDirty: false,
      enabled: true,
      revision: "r1",
      fileRevision: "file-r1",
      loading: false,
      saving: false,
      deleting: false,
      error: null,
      errorKind: null,
      errorAction: null,
      conflict: false,
      draftKept: false,
      ...overrides,
    },
    actions: {
      open: vi.fn(),
      close: vi.fn(),
      setScope: vi.fn(async () => undefined),
      setQuery: vi.fn(),
      select: vi.fn(async () => undefined),
      setDraft: vi.fn(),
      setEnabled: vi.fn(),
      refresh: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      overwrite: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      reloadSelected: vi.fn(async () => undefined),
      keepDraft: vi.fn(),
    },
  };
}

afterEach(() => cleanup());

describe("rules panel", () => {
  test("renders search, CAS revision and rule actions", () => {
    render(
      <OverlayHost>
        <RulesPanel controller={controller()} />
      </OverlayHost>,
    );
    expect(screen.getAllByRole("heading", { name: "Rules" })[0]).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search rules" })).toBeTruthy();
    expect(screen.getByText("Changes are saved when you choose Save rule.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete rule" })).toBeTruthy();
  });
  test("shows the close control by default and omits it when the drawer owns tab closing", () => {
    const closeable = render(
      <OverlayHost>
        <RulesPanel controller={controller()} />
      </OverlayHost>,
    );
    expect(screen.getByRole("button", { name: "Close Rules" })).toBeTruthy();
    closeable.unmount();

    render(
      <OverlayHost>
        <RulesPanel controller={controller()} closable={false} />
      </OverlayHost>,
    );
    expect(screen.queryByRole("button", { name: "Close Rules" })).toBeNull();
  });
  test("keeps action failures inline and retries the failed save", () => {
    const current = controller({
      draft: "Unsaved rule.",
      draftDirty: true,
      error: new AppFailure({
        code: "internal",
        message: "Rule could not be saved.",
        retryable: true,
      }),
      errorKind: "action",
      errorAction: "save",
    });
    render(
      <OverlayHost>
        <RulesPanel controller={current} />
      </OverlayHost>,
    );
    expect(screen.getByText("Rule could not be saved.")).toBeTruthy();
    expect(screen.queryByText("Unable to load this panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(current.actions.save).toHaveBeenCalledTimes(1);
  });
  test("disables Save and Delete while a conflict is open, and offers the three ways out", () => {
    render(
      <OverlayHost>
        <RulesPanel
          controller={controller({ draft: "Unsaved rule.", draftDirty: true, conflict: true })}
        />
      </OverlayHost>,
    );
    expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Delete rule" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Reload newer rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep my draft" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Overwrite newer rule" })).toBeTruthy();
  });
  test("says that nothing was found once, and only after a search", () => {
    const none = { rules: [], selected: undefined, draft: "", draftDirty: false };
    const searching = render(
      <OverlayHost>
        <RulesPanel controller={controller({ ...none, query: "zzz" })} />
      </OverlayHost>,
    );
    expect(screen.getAllByText("No rules found")).toHaveLength(1);
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    searching.unmount();
    render(
      <OverlayHost>
        <RulesPanel controller={controller({ ...none, query: "" })} />
      </OverlayHost>,
    );
    expect(screen.queryByText("No rules found")).toBeNull();
    expect(screen.getAllByText("Nothing here yet")).toHaveLength(1);
  });
  test("explains when RULES.md is applied or skipped", () => {
    render(
      <OverlayHost>
        <RulesPanel controller={controller({}, true)} />
      </OverlayHost>,
    );
    expect(screen.getByText("omp applies this file to every request.")).toBeTruthy();
    cleanup();
    render(
      <OverlayHost>
        <RulesPanel controller={controller({ enabled: false }, true)} />
      </OverlayHost>,
    );
    expect(screen.getByText("omp does not use this file.")).toBeTruthy();
  });
  test("says nothing about RULES.md on any other rule file, enabled or not", () => {
    for (const enabled of [true, false]) {
      render(
        <OverlayHost>
          <RulesPanel controller={controller({ enabled })} />
        </OverlayHost>,
      );
      expect(screen.getByText("Rule details")).toBeTruthy();
      expect(screen.queryByText("omp applies this file to every request.")).toBeNull();
      expect(screen.queryByText("omp does not use this file.")).toBeNull();
      cleanup();
    }
  });
});

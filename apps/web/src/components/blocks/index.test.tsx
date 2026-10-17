import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Button } from "@/components/ui/button";
import {
  ConflictBanner,
  EmptyState,
  InlineError,
  ListRow,
  Notice,
  Panel,
  Section,
  SettingRow,
  Toolbar,
} from "./index";

afterEach(cleanup);

test("Panel labels its surface, composes header slots, and scrolls its body internally", () => {
  const titleRef = vi.fn();
  const { container } = render(
    <Panel
      title="Panel heading"
      titleId="panel-heading"
      titleRef={titleRef}
      description="A panel description"
      descriptionId="panel-description"
      actions={<Button type="button">Close</Button>}
      status={<div role="status">Loading</div>}
      rootProps={{ "aria-describedby": "panel-description", "data-state": "loading" }}
      footer={<Button type="button">Save</Button>}
    >
      <p>Panel body</p>
    </Panel>,
  );

  const panelRegion = screen.getByRole("region", { name: "Panel heading" });
  expect(panelRegion.getAttribute("data-state")).toBe("loading");
  expect(screen.getByRole("status").textContent).toBe("Loading");
  expect(screen.getByText("Panel body").parentElement?.className).toContain("overflow-y-auto");
  expect(container.querySelector('[data-panel-scroll="body"]')).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  // A caller that holds a ref to the title can move focus there; it is never a tab stop.
  const heading = screen.getByRole("heading", { name: "Panel heading" });
  expect(titleRef).toHaveBeenCalledWith(heading);
  expect(heading.getAttribute("tabindex")).toBe("-1");
});

test("Section exposes its heading, description, actions, and content", () => {
  render(
    <Section
      heading="Appearance"
      headingId="appearance-title"
      description="Choose the app theme."
      actions={<span>Applied</span>}
    >
      <p>Section content</p>
    </Section>,
  );

  expect(screen.getByRole("region", { name: "Appearance" })).toBeTruthy();
  expect(screen.getByText("Choose the app theme.")).toBeTruthy();
  expect(screen.getByText("Applied")).toBeTruthy();
  expect(screen.getByText("Section content")).toBeTruthy();
});

test("ListRow preserves selected, focus, hover, and tooltip affordances", () => {
  const title = "A session title that is longer than the available row width";
  const onSelect = vi.fn();
  const onFocus = vi.fn();
  const { container } = render(
    <ListRow
      title={title}
      detail="Updated today"
      selected
      tabIndex={0}
      onSelect={onSelect}
      onFocus={onFocus}
    />,
  );
  const option = screen.getByRole("option", { name: /session title/ });

  expect(option.getAttribute("aria-selected")).toBe("true");
  expect(option.getAttribute("tabindex")).toBe("0");
  expect(option.className).toContain("focus-visible:ring-2");
  expect(container.firstElementChild?.className).toContain("hover:bg-sidebar-accent");
  expect(container.firstElementChild?.getAttribute("data-selected")).toBe("true");
  expect(container.querySelector(`[title="${title}"]`)?.className).toContain("truncate");

  fireEvent.focus(option);
  fireEvent.click(option);
  expect(onFocus).toHaveBeenCalledOnce();
  expect(onSelect).toHaveBeenCalledOnce();
});

test("ListRow disables selection and is a plain, unnamed row without onSelect", () => {
  const { rerender, container } = render(
    <ListRow title="Unavailable row" disabled onSelect={vi.fn()} />,
  );
  const option = screen.getByRole("option", { name: "Unavailable row" });
  expect((option as HTMLButtonElement).disabled).toBe(true);
  expect(option.getAttribute("aria-disabled")).toBe("true");
  expect(container.firstElementChild?.getAttribute("data-disabled")).toBe("true");

  rerender(<ListRow title="Read-only row" detail="Nothing to pick." />);
  expect(screen.queryByRole("option")).toBeNull();
  // A row that isn't selectable adds nothing to the accessibility tree beyond its text.
  expect(screen.queryByRole("group")).toBeNull();
  expect(screen.getByText("Nothing to pick.")).toBeTruthy();
});

test("SettingRow shows the label, help text and source beside its control", () => {
  render(
    <SettingRow
      title="Theme"
      description="Pick a surface."
      detail={<span data-testid="theme-source">Source: default</span>}
    >
      <Button type="button">System</Button>
    </SettingRow>,
  );
  expect(screen.getByText("Theme")).toBeTruthy();
  expect(screen.getByText("Pick a surface.")).toBeTruthy();
  expect(screen.getByTestId("theme-source").textContent).toBe("Source: default");
  expect(screen.getByRole("button", { name: "System" })).toBeTruthy();
});

test("Toolbar groups controls with a caller-provided accessible name", () => {
  render(
    <Toolbar ariaLabel="Section actions" alignment="end">
      <Button type="button">Cancel</Button>
      <Button type="button">Save</Button>
    </Toolbar>,
  );

  const toolbar = screen.getByRole("group", { name: "Section actions" });
  expect(toolbar.querySelectorAll("button").length).toBe(2);
  expect(toolbar.className).toContain("justify-end");
});

test("ConflictBanner shares rows, labels, and both explicit resolution actions", () => {
  const reload = vi.fn();
  const keepMine = vi.fn();
  render(
    <ConflictBanner
      description="Review the latest values."
      heading="Settings changed elsewhere"
      keepMineLabel="Keep my edits"
      onKeepMine={keepMine}
      onReload={reload}
      reloadLabel="Reload latest"
      rows={[
        { key: "theme.dark", label: "Theme", value: "Dark · Source: omp's default" },
        { key: "theme.light", label: "Theme", value: "Light · Source: Saved for this project" },
      ]}
    />,
  );

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Theme: Dark · Source: omp's default");
  expect(alert.textContent).toContain("Theme: Light · Source: Saved for this project");
  fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
  expect(reload).toHaveBeenCalledOnce();
  expect(keepMine).toHaveBeenCalledOnce();
});

test("EmptyState renders a title, hint, and optional action", () => {
  const onClick = vi.fn();
  const { rerender } = render(
    <EmptyState
      title="No sessions"
      hint="Start a chat to create one."
      action={
        <Button type="button" onClick={onClick}>
          New chat
        </Button>
      }
    />,
  );

  expect(screen.getByRole("status").textContent).toContain("Start a chat to create one.");
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(onClick).toHaveBeenCalledOnce();

  rerender(<EmptyState title="Nothing here" variant="compact" />);
  expect(screen.getByRole("status").textContent).toBe("Nothing here");
  expect(screen.queryByRole("button")).toBeNull();
});

test("large EmptyState keeps the transcript title and hint hierarchy", () => {
  const { container } = render(
    <EmptyState
      title="Ready when you are"
      hint="Choose a workspace folder and start a new session."
      variant="large"
    />,
  );
  expect(container.firstElementChild?.className).toContain("max-w-3xl");
  expect(screen.getByText("Ready when you are").className).toContain("text-lg");
  expect(
    screen.getByText("Choose a workspace folder and start a new session.").className,
  ).toContain("text-sm");
});

test("Notice keeps neutral and danger feedback in the shared floating block", () => {
  const { rerender } = render(<Notice message="Saved" />);
  expect(screen.getByRole("status").textContent).toBe("Saved");

  rerender(<Notice message="Could not save" tone="danger" />);
  expect(screen.getByRole("alert").textContent).toBe("Could not save");
});

test("InlineError exposes its message and invokes optional retry", () => {
  const retry = vi.fn();
  const { rerender } = render(<InlineError message="Unable to load this panel" onRetry={retry} />);

  expect(screen.getByRole("alert").textContent).toContain("Unable to load this panel");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();

  rerender(<InlineError message="Invalid setting" />);
  expect(screen.getByRole("alert").textContent).toContain("Invalid setting");
  expect(screen.queryByRole("button")).toBeNull();
});

test("InlineError shows its actions, and its details start closed behind Show details", () => {
  const act = vi.fn();
  render(
    <InlineError
      actions={
        <Button type="button" onClick={act}>
          Do the thing
        </Button>
      }
      details="raw words from the source"
      message="Something stopped."
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Do the thing" }));
  expect(act).toHaveBeenCalledOnce();
  const details = screen.getByText("Show details").closest("details");
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain("raw words from the source");
});

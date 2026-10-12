import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  type ConfigSnapshot,
  type SettingControl,
  SettingsSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  validate,
} from "@/modules/S1/settings-kit";

afterEach(cleanup);

const URL_CONTROL: SettingControl = {
  key: "dev.autoqaPush.endpoint",
  label: "Auto QA Push Endpoint",
  kind: "text",
  secret: false,
  validate: (value) => {
    if (value.secret || typeof value.value !== "string") {
      return { valid: false, code: "url", message: "Enter a valid URL." };
    }
    try {
      new URL(value.value);
      return { valid: true };
    } catch {
      return { valid: false, code: "url", message: "Enter a valid URL." };
    }
  },
  apply: "live",
};

const descriptor: SettingsSectionDescriptor = {
  id: "S1.hiddenValueTest",
  section: "appearance/Theme",
  title: "Developer settings",
  inventory: [],
  controls: [URL_CONTROL],
  requires: [],
};

/** The server hides a saved URL whose query carries a credential: it reads as secret. */
const savedHidden: ConfigSnapshot = {
  folder: null,
  revision: "rev-1",
  entries: [
    {
      key: "dev.autoqaPush.endpoint",
      secret: true,
      isSet: true,
      source: "global",
      overrides: [],
    },
  ],
};

function Harness({ snapshot }: { readonly snapshot: ConfigSnapshot }) {
  const initial: StagedSettings = { snapshot, edits: {} };
  const [staged, setStaged] = useState<StagedSettings>(initial);
  return (
    <SettingsSection
      descriptor={descriptor}
      snapshot={snapshot}
      staged={staged}
      onStage={setStaged}
      onCommit={() => undefined}
      onCancel={() => setStaged(initial)}
    />
  );
}

/** The Cancel that closes the open field: the one outside the section's "Settings actions" group. */
function fieldCancel(): HTMLElement {
  const group = screen.getByRole("group", { name: "Settings actions" });
  const button = screen
    .getAllByRole("button", { name: "Cancel" })
    .find((element) => !group.contains(element));
  if (!button) throw new Error("the field has no Cancel button");
  return button;
}

/** The section's own Cancel, which discards every change in the section. */
function sectionCancel(): HTMLElement {
  return within(screen.getByRole("group", { name: "Settings actions" })).getByRole("button", {
    name: "Cancel",
  });
}

describe("a hidden saved URL in the settings row", () => {
  test("offers Replace and Unset, and Unset stages the removal of the saved value", () => {
    render(<Harness snapshot={savedHidden} />);
    expect(screen.getByTestId("dev.autoqaPush.endpoint-hidden").textContent).toBe(
      "Saved for all projects; the value is hidden.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Unset" }));
    expect(screen.getByText("Will be unset when you save.")).toBeTruthy();
  });

  test("Replace opens a labelled hidden field, and the field takes the focus", () => {
    render(<Harness snapshot={savedHidden} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    const field = screen.getByLabelText("New address") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(document.activeElement).toBe(field);
  });

  test("Use this address refuses a value that is not a URL, and the field stays open", () => {
    render(<Harness snapshot={savedHidden} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    fireEvent.change(screen.getByLabelText("New address"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    expect(screen.getByText("Enter a valid URL.")).toBeTruthy();
    expect(screen.getByLabelText("New address")).toBeTruthy();
  });

  test("Use this address stages a valid address, closes the field and returns focus to Replace…", () => {
    render(<Harness snapshot={savedHidden} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    fireEvent.change(screen.getByLabelText("New address"), {
      target: { value: "https://qa.example.test/v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    expect(screen.queryByLabelText("New address")).toBeNull();
    expect(screen.getByText("A new address is ready to save.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace…" }));
  });

  test("Cancel closes the field, forgets the typed address and returns focus to Replace…", () => {
    render(<Harness snapshot={savedHidden} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    fireEvent.change(screen.getByLabelText("New address"), {
      target: { value: "https://qa.example.test/v2" },
    });
    fireEvent.click(fieldCancel());
    expect(screen.queryByLabelText("New address")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace…" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    expect((screen.getByLabelText("New address") as HTMLInputElement).value).toBe("");
  });

  test("the section's Cancel closes an open field and forgets the typed address", () => {
    render(<Harness snapshot={savedHidden} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    fireEvent.change(screen.getByLabelText("New address"), {
      target: { value: "https://qa.example.test/v2" },
    });
    fireEvent.click(sectionCancel());
    expect(screen.queryByLabelText("New address")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    expect((screen.getByLabelText("New address") as HTMLInputElement).value).toBe("");
  });

  test("a hidden value set in the environment reads as a sentence, with neither Replace nor Unset", () => {
    render(
      <Harness
        snapshot={{
          ...savedHidden,
          entries: [
            {
              key: "dev.autoqaPush.endpoint",
              secret: true,
              isSet: true,
              source: "env",
              overrides: ["default"],
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("dev.autoqaPush.endpoint-hidden").textContent).toBe(
      "Set in the environment; the value is hidden.",
    );
    expect(screen.queryByRole("button", { name: "Replace…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unset" })).toBeNull();
  });
});

describe("the kit's check of a hidden URL's secret edits", () => {
  test("Clear always passes for a hidden URL", () => {
    expect(validate(URL_CONTROL, { secret: true, action: "unset" }, savedHidden)).toEqual({
      valid: true,
    });
  });

  test("a new address for a hidden URL is checked as a plain URL", () => {
    expect(
      validate(URL_CONTROL, { secret: true, action: "set", value: "nope" }, savedHidden),
    ).toMatchObject({ valid: false, message: "Enter a valid URL." });
    expect(
      validate(
        URL_CONTROL,
        { secret: true, action: "set", value: "https://qa.example.test/v2" },
        savedHidden,
      ),
    ).toEqual({ valid: true });
  });

  test("a URL that is not hidden still refuses a secret edit", () => {
    const plain: ConfigSnapshot = {
      ...savedHidden,
      entries: [
        {
          key: "dev.autoqaPush.endpoint",
          secret: false,
          value: "https://qa.example.test/v1",
          source: "global",
          overrides: [],
        },
      ],
    };
    expect(validate(URL_CONTROL, { secret: true, action: "unset" }, plain)).toMatchObject({
      valid: false,
      code: "secret-kind",
    });
  });
});

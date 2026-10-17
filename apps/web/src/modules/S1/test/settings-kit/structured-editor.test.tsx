import type { JsonValue } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RowsSettingControl } from "../../settings-kit";
import { SELECT_DISABLED_LOOK } from "../../settings-kit/control-look";
import { StructuredEditor } from "../../settings-kit/structured";

afterEach(cleanup);

const rules: RowsSettingControl = {
  key: "bash.patterns",
  label: "Bash Approval Patterns",
  kind: "rows",
  secret: false,
  fields: {
    match: { label: "Command pattern", kind: "text" },
    approval: {
      label: "Approval",
      kind: "enum",
      options: [
        { value: "prompt", label: "Ask first" },
        { value: "allow", label: "Allow" },
      ],
    },
  },
  ordered: true,
  addLabel: "Add rule",
  emptyLabel: "No approval rules",
  validate: () => ({ valid: true }),
  apply: "reload",
};

const lsRule: JsonValue = [{ match: "ls *", approval: "prompt" }];
const rmRule: JsonValue = [{ match: "rm *", approval: "deny" }];

function editor(props: {
  readonly value: JsonValue | undefined;
  readonly committed: JsonValue | undefined;
  readonly resetToken?: number;
  readonly onValue?: (value: JsonValue) => void;
}) {
  return (
    <StructuredEditor
      committed={props.committed}
      control={rules}
      disabled={false}
      onInvalid={() => undefined}
      onValue={props.onValue ?? (() => undefined)}
      resetToken={props.resetToken ?? 0}
      value={props.value}
    />
  );
}

describe("structured editor follows a stored value without dropping a staged edit", () => {
  test("a stored value that changes under a staged edit keeps the rows the user is saving", () => {
    // The user added `ls *`; another writer then stored `rm *`. "Keep mine" leaves the staged value at `ls *`.
    const { rerender } = render(editor({ value: lsRule, committed: undefined }));
    rerender(editor({ value: lsRule, committed: rmRule }));

    expect(
      (screen.getByLabelText("Bash Approval Patterns: Command pattern 1") as HTMLInputElement)
        .value,
    ).toBe("ls *");
    expect(screen.queryByDisplayValue("rm *")).toBeNull();
  });

  test("Cancel (a new reset token) drops the staged edit and shows the stored value", () => {
    const { rerender } = render(editor({ value: lsRule, committed: rmRule }));
    rerender(editor({ value: rmRule, committed: rmRule, resetToken: 1 }));

    expect(
      (screen.getByLabelText("Bash Approval Patterns: Command pattern 1") as HTMLInputElement)
        .value,
    ).toBe("rm *");
  });
});

describe("structured editor keyboard focus and names", () => {
  test("Add moves focus to the new row's first field", () => {
    render(editor({ value: lsRule, committed: lsRule }));

    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    expect(document.activeElement).toBe(
      screen.getByLabelText("Bash Approval Patterns: Command pattern 2"),
    );
  });

  test("Remove moves focus to Add rule, because the removed row's button is gone", () => {
    render(
      editor({
        value: [
          { match: "ls *", approval: "prompt" },
          { match: "rm *", approval: "deny" },
        ],
        committed: undefined,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add rule" }));
  });

  test("the rows sit in a group named after their setting", () => {
    render(editor({ value: lsRule, committed: lsRule }));

    expect(screen.getByRole("group", { name: "Bash Approval Patterns" })).toBeTruthy();
  });
});

describe("structured editor edits", () => {
  test("a row edit reports the complete value", () => {
    const onValue = vi.fn();
    render(editor({ value: lsRule, committed: lsRule, onValue }));

    fireEvent.change(screen.getByLabelText("Bash Approval Patterns: Command pattern 1"), {
      target: { value: "git *" },
    });

    expect(onValue).toHaveBeenLastCalledWith([{ match: "git *", approval: "prompt" }]);
  });
});

test("an unknown stored enum names its explicit recovery value and returns focus to the field", async () => {
  const malformed: JsonValue = [{ match: "ls *", approval: "bogus" }];
  function Harness() {
    const [value, setValue] = useState<JsonValue>(malformed);
    return (
      <StructuredEditor
        committed={value}
        control={rules}
        disabled={false}
        onInvalid={() => undefined}
        onValue={setValue}
        resetToken={0}
        value={value}
      />
    );
  }

  render(<Harness />);
  expect(screen.getByText("This field has an unrecognized value.")).toBeTruthy();
  const useOption = screen.getByRole("button", { name: "Use Ask first" });
  fireEvent.click(useOption);
  const approval = screen.getByRole("combobox", {
    name: "Bash Approval Patterns: Approval 1",
  }) as HTMLSelectElement;
  await waitFor(() => expect(document.activeElement).toBe(approval));
  expect(approval.value).toBe("prompt");
});

describe("structured editor draws a disabled row the way the kit draws its other disabled controls", () => {
  const withSwitch: RowsSettingControl = {
    ...rules,
    fields: { ...rules.fields, enabled: { label: "Enabled", kind: "boolean" } },
  };
  const switched: JsonValue = [{ match: "ls *", approval: "prompt", enabled: true }];

  function renderSwitched(disabled: boolean) {
    return (
      <StructuredEditor
        committed={switched}
        control={withSwitch}
        disabled={disabled}
        onInvalid={() => undefined}
        onValue={() => undefined}
        resetToken={0}
        value={switched}
      />
    );
  }

  test("a stored non-boolean structured value stays visible and Reset focuses the checkbox", async () => {
    const malformed: JsonValue = [{ match: "ls *", approval: "prompt", enabled: "yes" }];
    function Harness() {
      const [value, setValue] = useState<JsonValue>(malformed);
      return (
        <StructuredEditor
          committed={value}
          control={withSwitch}
          disabled={false}
          onInvalid={() => undefined}
          onValue={setValue}
          resetToken={0}
          value={value}
        />
      );
    }

    render(<Harness />);
    expect(screen.getByText("This field has an unrecognized value.")).toBeTruthy();
    const reset = screen.getByRole("button", { name: "Turn off" });
    fireEvent.click(reset);
    const enabled = screen.getByRole("checkbox", {
      name: "Bash Approval Patterns: Enabled 1",
    }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(enabled));
    expect(enabled.checked).toBe(false);
  });

  test("a disabled dropdown and checkbox row carry the disabled look, and an enabled one does not", () => {
    const { rerender } = render(renderSwitched(true));

    expect(
      screen.getByRole("combobox", { name: "Bash Approval Patterns: Approval 1" }).className,
    ).toContain(SELECT_DISABLED_LOOK);
    const disabledRow = screen
      .getByRole("checkbox", { name: "Bash Approval Patterns: Enabled 1" })
      .closest("label");
    expect(disabledRow?.className).toContain("cursor-not-allowed");
    expect(disabledRow?.className).toContain("opacity-50");

    rerender(renderSwitched(false));
    const enabledRow = screen
      .getByRole("checkbox", { name: "Bash Approval Patterns: Enabled 1" })
      .closest("label");
    expect(enabledRow?.className).toContain("cursor-pointer");
    expect(enabledRow?.className).not.toContain("opacity-50");
  });
});

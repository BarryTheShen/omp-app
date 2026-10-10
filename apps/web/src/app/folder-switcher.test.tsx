import { FolderPath } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FolderSwitcher } from "./folder-switcher";

afterEach(cleanup);

const open = FolderPath.parse("/workspace/project");
const missing = "/no/such/folder/anywhere";

function renderPicker(onOtherFolder: (folder: string) => Promise<boolean>): HTMLSelectElement {
  render(
    <FolderSwitcher
      error={null}
      folder={open}
      onFolderChange={vi.fn()}
      onOtherFolder={onOtherFolder}
      recentFolders={[]}
    />,
  );
  return screen.getByRole("combobox", { name: "Workspace folder" }) as HTMLSelectElement;
}

/** Opens "Other folder…", types the path and presses Use. */
function useOtherFolder(path: string): void {
  fireEvent.change(screen.getByRole("combobox", { name: "Workspace folder" }), {
    target: { value: "__other__" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Other folder path" }), {
    target: { value: path },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use" }));
}

function otherFolderField(): HTMLInputElement | null {
  return screen.queryByRole("textbox", { name: "Other folder path" }) as HTMLInputElement | null;
}

describe("the workspace folder picker", () => {
  test("a folder that cannot be opened closes the field and the picker shows the folder still open", async () => {
    const onOtherFolder = vi.fn(async () => false);
    const select = renderPicker(onOtherFolder);
    useOtherFolder(missing);
    await waitFor(() => expect(otherFolderField()).toBeNull());
    expect(onOtherFolder).toHaveBeenCalledWith(missing);
    expect(select.value).toBe(open);
    expect(document.activeElement).toBe(select);
  });

  test("the typed path stays after a failure, so it can be corrected", async () => {
    const select = renderPicker(vi.fn(async () => false));
    useOtherFolder(missing);
    await waitFor(() => expect(otherFolderField()).toBeNull());
    fireEvent.change(select, { target: { value: "__other__" } });
    expect(otherFolderField()?.value).toBe(missing);
  });

  test("a folder that opens closes the field and clears the typed path", async () => {
    const select = renderPicker(vi.fn(async () => true));
    useOtherFolder("/workspace/other");
    await waitFor(() => expect(otherFolderField()).toBeNull());
    fireEvent.change(select, { target: { value: "__other__" } });
    expect(otherFolderField()?.value).toBe("");
  });
});

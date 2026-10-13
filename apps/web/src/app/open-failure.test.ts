import { FolderPath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { type OpenFailure, openFailureIn } from "./open-failure";

const folderA = FolderPath.parse("/workspace/a");
const folderB = FolderPath.parse("/workspace/b");

/** A saved chat in folder A whose model is gone: the empty screen would offer the picker for it. */
const failure: OpenFailure = {
  folder: folderA,
  threadId: ThreadId.parse("saved-chat-in-a"),
  error: {
    code: "model_unavailable",
    message: "This chat used fake/gone-model, which is not available any more.",
    retryable: false,
  },
};

describe("openFailureIn (issue 1316)", () => {
  test("shows a failure on the folder its saved chat was in", () => {
    expect(openFailureIn(failure, folderA)).toBe(failure);
  });

  test("shows nothing on another folder, so a folder change clears the old folder's failure", () => {
    expect(openFailureIn(failure, folderB)).toBeNull();
  });

  test("shows nothing without a failure, without a folder on screen, or for a failure with no folder", () => {
    expect(openFailureIn(null, folderA)).toBeNull();
    expect(openFailureIn(failure, null)).toBeNull();
    expect(openFailureIn({ ...failure, folder: null }, folderA)).toBeNull();
  });
});

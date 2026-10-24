import type { FolderPath } from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { FOLDER_KEY, rememberLaunchFolder, THREAD_KEY, UNSENT_CHAT_KEY } from "./session-storage";

const LAUNCHED = "/work/launched" as FolderPath;

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("rememberLaunchFolder", () => {
  test("remembers the folder like a folder picked by hand, over the one remembered before", () => {
    window.localStorage.setItem(FOLDER_KEY, "/work/remembered");
    rememberLaunchFolder(LAUNCHED);
    expect(window.localStorage.getItem(FOLDER_KEY)).toBe(LAUNCHED);
  });

  test("forgets the chat and the unsent-chat marker of the folder it leaves", () => {
    window.localStorage.setItem(FOLDER_KEY, "/work/remembered");
    window.localStorage.setItem(THREAD_KEY, "thread-1");
    window.sessionStorage.setItem(UNSENT_CHAT_KEY, "thread-2");
    rememberLaunchFolder(LAUNCHED);
    expect(window.localStorage.getItem(THREAD_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(UNSENT_CHAT_KEY)).toBeNull();
  });

  test("keeps the chat remembered for the folder it names", () => {
    window.localStorage.setItem(FOLDER_KEY, LAUNCHED);
    window.localStorage.setItem(THREAD_KEY, "thread-1");
    window.sessionStorage.setItem(UNSENT_CHAT_KEY, "thread-2");
    rememberLaunchFolder(LAUNCHED);
    expect(window.localStorage.getItem(FOLDER_KEY)).toBe(LAUNCHED);
    expect(window.localStorage.getItem(THREAD_KEY)).toBe("thread-1");
    expect(window.sessionStorage.getItem(UNSENT_CHAT_KEY)).toBe("thread-2");
  });
});

import { ThreadId } from "@omp-app/contracts";
import { beforeEach, describe, expect, test } from "vitest";
import { pickedModelFor, rememberPickedModel } from "./picked-model";

const STORAGE_KEY = "omp-app.picked-models";
const one = ThreadId.parse("thread-one");
const two = ThreadId.parse("thread-two");

describe("the model picked for a chat", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("is kept for the chat it was picked for, and no other chat", () => {
    rememberPickedModel(one, { provider: "fake", modelId: "fake-model" });

    expect(pickedModelFor(one)).toEqual({ provider: "fake", modelId: "fake-model" });
    expect(pickedModelFor(two)).toBeUndefined();
  });

  test("ignores a stored value that is not a model choice", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ [one]: { provider: 3 } }));

    expect(pickedModelFor(one)).toBeUndefined();
  });

  test("names no model when the stored text is not JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not json");

    expect(pickedModelFor(one)).toBeUndefined();
  });
});

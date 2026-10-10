import { describe, expect, test } from "vitest";
import { describeShareConfirmation, type ShareSettings } from "./confirm";

const BLOB: ShareSettings = {
  serverUrl: "https://my.omp.sh/s",
  store: "blob",
  redactSecrets: true,
};

describe("the share question", () => {
  test("asks whether to share, and names the destination before anything is sent", () => {
    const { title, message } = describeShareConfirmation(BLOB);
    expect(title).toBe("Share this chat as a link?");
    expect(message).toContain("It is encrypted and uploaded to https://my.omp.sh/s.");
  });

  test("names what leaves the machine: the whole chat, its tool output and the files it mentions", () => {
    const { message } = describeShareConfirmation(BLOB);
    expect(message).toContain("This sends the whole chat off this computer");
    expect(message).toContain("tool output");
    expect(message).toContain("the text of files the chat mentions");
  });

  test("says who can open the link, and that a link cannot be taken back", () => {
    const { message } = describeShareConfirmation(BLOB);
    expect(message).toContain("anyone who has it can open the chat");
    expect(message).toContain("Private and team links need omp to add them first.");
    expect(message).toContain("A link cannot be taken back.");
  });

  test("a gist names the secret gist under the person's account, and the server it falls back to", () => {
    const { message } = describeShareConfirmation({ ...BLOB, store: "gist" });
    expect(message).toContain(
      "It is encrypted and uploaded as a secret GitHub gist under your GitHub account.",
    );
    expect(message).toContain("If that fails, it is uploaded to https://my.omp.sh/s instead.");
  });

  test("states the redaction setting in plain words, both ways", () => {
    expect(describeShareConfirmation(BLOB).message).toContain(
      "Secret redaction is on, so secrets that omp knows about are replaced before the upload.",
    );
    expect(describeShareConfirmation({ ...BLOB, redactSecrets: false }).message).toContain(
      "Secret redaction is off, so secrets in this chat are uploaded as they are.",
    );
  });

  test("names the server it is given, and no other", () => {
    const { message } = describeShareConfirmation({
      ...BLOB,
      serverUrl: "https://share.example.test/viewer",
    });
    expect(message).toContain("https://share.example.test/viewer");
    expect(message).not.toContain("my.omp.sh");
  });

  test("uses no internal names", () => {
    const { title, message } = describeShareConfirmation({ ...BLOB, store: "gist" });
    expect(`${title} ${message}`).not.toMatch(/share\.serverUrl|ConfigStore|RPC|Share Secret/);
  });
});

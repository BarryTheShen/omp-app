import { describe, expect, test } from "bun:test";
import { providerErrorDetails } from "./sessions/worker-reason";

const SAVED_REQUEST = "/example/omp-home/logs/http-400-requests/request.json";
const PROVIDER_MESSAGE = "400 fake provider failure for the failing subagent";
const PROVIDER_TEXT = [
  PROVIDER_MESSAGE,
  "fake provider failure for the failing subagent (type=invalid_request_error)",
  `raw-http-request=${SAVED_REQUEST}`,
].join("\n");

describe("providerErrorDetails", () => {
  test("keeps the provider message once and excludes the saved request path", () => {
    const result = providerErrorDetails(PROVIDER_TEXT);
    expect(result).toEqual({
      message: `${PROVIDER_MESSAGE} (type=invalid_request_error)`,
    });
    expect(JSON.stringify(result)).not.toContain(SAVED_REQUEST);
    expect(JSON.stringify(result)).not.toContain("raw-http-request");
  });

  test("returns a safe save-failure reason without the local path", () => {
    const path = "/example/omp-home/logs/http-400-requests/request.json";
    const result = providerErrorDetails(
      `400 bad block\nraw-http-request-save-failed=EACCES: permission denied, open '${path}'`,
    );
    expect(result).toEqual({
      message: "400 bad block",
      requestLogSaveFailureReason: "EACCES: permission denied",
    });
    expect(JSON.stringify(result)).not.toContain(path);
  });

  test("keeps non-diagnostic lines that do not repeat the first line", () => {
    expect(providerErrorDetails("400 bad block\nmessages.0 has no content")).toEqual({
      message: "400 bad block messages.0 has no content",
    });
  });

  test("returns an empty message when omp only supplied a saved-request diagnostic", () => {
    expect(providerErrorDetails(`raw-http-request=${SAVED_REQUEST}`)).toEqual({ message: "" });
  });
});

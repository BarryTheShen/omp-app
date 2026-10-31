import { pairingLink } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { codeFromAddress } from "./pairing-api";

describe("a pairing QR code's address", () => {
  test("opens the app's page, which reads back the code; other addresses carry none", () => {
    const opened = new URL(pairingLink("https://app.example.ts.net/", "K7F3QX9M"));
    expect(opened.pathname).toBe("/");
    expect(codeFromAddress(opened.hash)).toBe("K7F3QX9M");
    expect(codeFromAddress("#token=abc&folder=%2Fhome")).toBeNull();
    expect(codeFromAddress("")).toBeNull();
  });
});

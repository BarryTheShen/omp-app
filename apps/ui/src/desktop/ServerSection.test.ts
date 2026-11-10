import { describe, expect, test } from "vitest";
import { otherServer } from "./ServerSection";

describe("another server's address, in a browser", () => {
  test("an https address goes to its root; a launch link keeps its token, and nothing else after the address", () => {
    expect(otherServer("  https://omp.example.com  ")).toEqual({
      address: "https://omp.example.com/",
    });
    expect(otherServer("https://omp.example.com:8443/lite?chat=1#token=abc")).toEqual({
      address: "https://omp.example.com:8443/#token=abc",
    });
    expect(otherServer("https://omp.example.com/#pair=XYZ")).toEqual({
      address: "https://omp.example.com/",
    });
  });

  test("plain http only for the app on this computer, with its port", () => {
    expect(otherServer("http://127.0.0.1:4317")).toEqual({ address: "http://127.0.0.1:4317/" });
    expect(otherServer("http://localhost:4317/")).toEqual({ address: "http://localhost:4317/" });
    for (const refused of ["http://omp.example.com", "http://127.0.0.1", "ftp://omp.example.com"])
      expect(otherServer(refused), refused).toHaveProperty("problem");
  });

  test("text that is not an address says so", () => {
    expect(otherServer("omp.example.com")).toEqual({
      problem: '"omp.example.com" is not an address: it starts with https://.',
    });
  });
});

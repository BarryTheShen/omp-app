import { describe, expect, test } from "vitest";
import { shippedSources } from "./shipped";

/**
 * An import of the server, of omp's process or wire layer, of a serving platform, or of a Node built-in: by its
 * `node:` name or its bare name (`fs`, `path`, ...). A bare name matches the whole specifier, so `./path` is not one.
 */
const FORBIDDEN_IMPORT =
  /(?:from\s+|import\(\s*|import\s+|require\(\s*)["'](?:[^"']*(?:@omp-app\/server|packages\/server|omp-rpc|omp-wire|rpc-wire|child_process|@tauri-apps|electron)[^"']*|node:[^"']*|fs|fs\/promises|path|os|crypto|net|http|https|stream|url|process|buffer|module)["']/;

/** A raw transport: a direct request, a socket or an event stream. P4 reaches omp only through its typed seam. */
const RAW_TRANSPORT = /\bfetch\s*\(|new WebSocket\s*\(|\bEventSource\b|\bXMLHttpRequest\b/;

/** omp's send seam and its wire types, by name. */
const OMP_SEAM = /\b(?:RpcSessionSend|OmpWire)\b/;

/** The only shipped files that name omp's seam: the history reader and the conversation transitions. */
const ADAPTERS = ["history/history.ts", "transitions/transitions.ts"];

/** An import of an adapter or of R0's runtime: a static import, a side-effect import, or a dynamic one. */
const ADAPTER_OR_RUNTIME_IMPORT =
  /(?:from\s+|import\(\s*|import\s+|require\(\s*)["'](?:\.\.?\/(?:history|transitions)(?:\/[^"']*)?|@\/modules\/R0\/[^"']*)["']/;

/** The selector and labels views, controllers and models: they depend on contract types, not on the adapters. */
const PRESENTATION = /^(?:selector|labels)\//;

/** The shipped P4 sources. Every check below reads them through here, so an empty scan fails instead of passing. */
function scannedSources() {
  const sources = shippedSources();
  expect(sources.length).toBeGreaterThan(10);
  return sources;
}

describe("W6 boundary: shipped P4 code has no server, wire or raw-transport imports, and reaches omp only through typed seams", () => {
  test("the shipped P4 sources are found, so the checks below cannot pass on an empty scan", () => {
    expect(shippedSources().length).toBeGreaterThan(10);
  });

  test("no shipped P4 file imports the server, omp's process or wire layer, a serving platform or a Node built-in", () => {
    expect(
      scannedSources()
        .filter((file) => FORBIDDEN_IMPORT.test(file.text))
        .map((file) => file.path),
    ).toEqual([]);
  });

  test("no shipped P4 file calls a raw transport", () => {
    expect(
      scannedSources()
        .filter((file) => RAW_TRANSPORT.test(file.text))
        .map((file) => file.path),
    ).toEqual([]);
  });

  test("only the history reader and the conversation transitions name omp's send seam or its wire types", () => {
    expect(
      scannedSources()
        .filter((file) => OMP_SEAM.test(file.text))
        .map((file) => file.path)
        .sort(),
    ).toEqual([...ADAPTERS].sort());
  });

  test("the selector and labels views, controllers and models import contract types, not the adapters or R0", () => {
    expect(
      scannedSources()
        .filter((file) => PRESENTATION.test(file.path) && ADAPTER_OR_RUNTIME_IMPORT.test(file.text))
        .map((file) => file.path),
    ).toEqual([]);
  });
});

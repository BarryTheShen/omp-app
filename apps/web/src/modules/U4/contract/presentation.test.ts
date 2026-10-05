import type { OmpWire } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  NotifyHandoffSchema,
  OpenUrlHandoffSchema,
  openUrlCopyTarget,
  PresentationHandoffSchema,
  SetEditorTextHandoffSchema,
  SetStatusHandoffSchema,
  SetTitleHandoffSchema,
  SetWidgetHandoffSchema,
  toPresentationHandoff,
} from "./presentation";

describe("handoff schemas", () => {
  test("accept a representative value for each of the six kinds", () => {
    expect(
      NotifyHandoffSchema.safeParse({ kind: "notify", message: "Done", notifyType: "info" })
        .success,
    ).toBe(true);
    expect(
      SetStatusHandoffSchema.safeParse({ kind: "setStatus", statusKey: "k", statusText: "Working" })
        .success,
    ).toBe(true);
    expect(
      SetWidgetHandoffSchema.safeParse({
        kind: "setWidget",
        widgetKey: "w",
        widgetLines: ["a", "b"],
        widgetPlacement: "belowEditor",
      }).success,
    ).toBe(true);
    expect(SetTitleHandoffSchema.safeParse({ kind: "setTitle", title: "New title" }).success).toBe(
      true,
    );
    expect(
      SetEditorTextHandoffSchema.safeParse({ kind: "set_editor_text", text: "" }).success,
    ).toBe(true);
    expect(
      OpenUrlHandoffSchema.safeParse({
        kind: "open_url",
        url: "https://provider.example/oauth?token=secret",
        launchUrl: "https://localhost/callback",
      }).success,
    ).toBe(true);
  });

  test("reject an unknown notifyType, an unknown widget placement, and a missing url", () => {
    expect(
      NotifyHandoffSchema.safeParse({ kind: "notify", message: "Done", notifyType: "debug" })
        .success,
    ).toBe(false);
    expect(
      SetWidgetHandoffSchema.safeParse({
        kind: "setWidget",
        widgetKey: "w",
        widgetPlacement: "left",
      }).success,
    ).toBe(false);
    expect(OpenUrlHandoffSchema.safeParse({ kind: "open_url" }).success).toBe(false);
  });

  test("PresentationHandoffSchema discriminates all six kinds and rejects a modal kind", () => {
    expect(PresentationHandoffSchema.safeParse({ kind: "setTitle", title: "T" }).success).toBe(
      true,
    );
    expect(
      PresentationHandoffSchema.safeParse({ kind: "confirm", title: "T", message: "M" }).success,
    ).toBe(false);
  });
});

describe("openUrlCopyTarget", () => {
  test("prefers the short launchUrl so terminal/log truncation cannot corrupt OAuth params", () => {
    expect(
      openUrlCopyTarget({
        kind: "open_url",
        url: "https://long.example/auth?x=1",
        launchUrl: "https://short",
      }),
    ).toBe("https://short");
  });

  test("falls back to the full url only when omp gave no launchUrl", () => {
    expect(openUrlCopyTarget({ kind: "open_url", url: "https://only.example" })).toBe(
      "https://only.example",
    );
  });
});

describe("toPresentationHandoff", () => {
  test("converts each of the six wire requests, keeping field names exact", () => {
    expect(
      toPresentationHandoff({
        type: "extension_ui_request",
        id: "w1",
        method: "notify",
        message: "Done",
        notifyType: "warning",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toEqual({ kind: "notify", message: "Done", notifyType: "warning" });

    expect(
      toPresentationHandoff({
        type: "extension_ui_request",
        id: "w2",
        method: "setStatus",
        statusKey: "k",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toEqual({ kind: "setStatus", statusKey: "k", statusText: undefined });

    expect(
      toPresentationHandoff({
        type: "extension_ui_request",
        id: "w3",
        method: "setWidget",
        widgetKey: "w",
        widgetLines: ["a"],
        widgetPlacement: "aboveEditor",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toEqual({
      kind: "setWidget",
      widgetKey: "w",
      widgetLines: ["a"],
      widgetPlacement: "aboveEditor",
    });

    expect(
      toPresentationHandoff({
        type: "extension_ui_request",
        id: "w4",
        method: "setTitle",
        title: "T",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toEqual({ kind: "setTitle", title: "T" });

    expect(
      toPresentationHandoff({
        type: "extension_ui_request",
        id: "w5",
        method: "set_editor_text",
        text: "hello",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toEqual({ kind: "set_editor_text", text: "hello" });

    expect(
      toPresentationHandoff({
        type: "extension_ui_request",
        id: "w6",
        method: "open_url",
        url: "https://x",
        launchUrl: "https://short",
        instructions: "paste this",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toEqual({
      kind: "open_url",
      url: "https://x",
      launchUrl: "https://short",
      instructions: "paste this",
    });
  });

  test("throws AppFailure(internal) for a modal or cancel method", () => {
    expect(() =>
      toPresentationHandoff({
        type: "extension_ui_request",
        id: "w7",
        method: "confirm",
        title: "T",
        message: "M",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toThrow(AppFailure);
    expect(() =>
      toPresentationHandoff({
        type: "extension_ui_request",
        id: "w8",
        method: "cancel",
        targetId: "w1",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toThrow(AppFailure);
  });
});

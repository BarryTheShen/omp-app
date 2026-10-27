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
  test("converts each of the host's six UI events, keeping omp's field values", () => {
    expect(
      toPresentationHandoff({ type: "ui_notify", message: "Done", notifyType: "warning" }),
    ).toEqual({ kind: "notify", message: "Done", notifyType: "warning" });
    expect(toPresentationHandoff({ type: "ui_status", statusKey: "k" })).toEqual({
      kind: "setStatus",
      statusKey: "k",
      statusText: undefined,
    });
    expect(
      toPresentationHandoff({
        type: "ui_widget",
        widgetKey: "w",
        widgetLines: ["a"],
        widgetPlacement: "aboveEditor",
      }),
    ).toEqual({
      kind: "setWidget",
      widgetKey: "w",
      widgetLines: ["a"],
      widgetPlacement: "aboveEditor",
    });
    expect(toPresentationHandoff({ type: "ui_title", title: "T" })).toEqual({
      kind: "setTitle",
      title: "T",
    });
    expect(toPresentationHandoff({ type: "ui_editor_text", text: "hello" })).toEqual({
      kind: "set_editor_text",
      text: "hello",
    });
    expect(
      toPresentationHandoff({
        type: "ui_open_url",
        url: "https://x",
        launchUrl: "https://short",
        instructions: "paste this",
      }),
    ).toEqual({
      kind: "open_url",
      url: "https://x",
      launchUrl: "https://short",
      instructions: "paste this",
    });
  });

  test("a widget with no lines clears it: the handoff has no lines either", () => {
    expect(toPresentationHandoff({ type: "ui_widget", widgetKey: "w" })).toEqual({
      kind: "setWidget",
      widgetKey: "w",
      widgetLines: undefined,
      widgetPlacement: undefined,
    });
  });
});

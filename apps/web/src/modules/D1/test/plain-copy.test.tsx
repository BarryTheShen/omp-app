import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { D1_MODEL_CATALOG_RPC_FIXTURE } from "../fixtures";
import { ModelHub } from "../hub";
import { ModelCatalogModel } from "../model";
import { ModelPresetControls } from "../settings/model-settings";

afterEach(() => cleanup());

/** Internal names a person must never read: the config store, the revision check, the layer and the role-map wording. */
const INTERNAL_TERMS = /ConfigStore|\bCAS\b|role map|A1\.4|config layer/;

describe("D1 model copy says what a person can do, in plain words", () => {
  test("the saved presets say what saving a set of models does", () => {
    render(
      <ModelPresetControls
        presets={{
          presets: ["balanced"],
          save: async () => undefined,
          switch: async () => undefined,
          remove: async () => undefined,
        }}
      />,
    );
    expect(
      screen.getByText("Save a set of models for each role and switch between them."),
    ).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(INTERNAL_TERMS);
  });

  test("the hub says why saved model sets are unavailable: omp's settings have not loaded", () => {
    const catalog = new ModelCatalogModel({
      source: {
        getAvailableModels: async () => D1_MODEL_CATALOG_RPC_FIXTURE.models,
        setModel: async () => {
          throw new Error("This test does not change the model.");
        },
      },
    });
    render(<ModelHub catalog={catalog} />);
    fireEvent.click(screen.getByText("Roles", { selector: "button" }));
    expect(
      screen.getByText("Saved model sets are unavailable until omp's settings load."),
    ).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(INTERNAL_TERMS);
    catalog.dispose();
  });
});

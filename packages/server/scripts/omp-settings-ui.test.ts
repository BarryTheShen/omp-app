import { expect, test } from "bun:test";
import { OMP_SETTINGS_UI_PATH, ompSettingsForUi } from "./omp-settings-ui";

test("the new UI's copy of omp's settings matches the omp this package pins", async () => {
  const committed: unknown = await Bun.file(OMP_SETTINGS_UI_PATH).json();
  // Stale after an omp upgrade: run `bun packages/server/scripts/omp-settings-ui.ts` and review the diff.
  expect(committed).toEqual(JSON.parse(JSON.stringify(ompSettingsForUi())));
});

test("omp's self-update is left out of the copy while the rest of its update settings stay", () => {
  const keys = ompSettingsForUi().settings.map((setting) => setting.key);
  expect(keys).not.toContain("update.auto");
  expect(keys).toContain("update.channel");
});

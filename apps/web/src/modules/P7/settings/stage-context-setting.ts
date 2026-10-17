import { AppFailure } from "@omp-app/contracts";
import type { SettingsRuntime } from "../../S1/runtime";
import type { SettingValue } from "../../S1/settings-kit";

/** Keeps each refused edit until the saving phase ends; each call holds a listener until that transition. */
export function stageContextSetting(
  runtime: SettingsRuntime,
  key: string,
  value: SettingValue,
): void {
  const result = runtime.stage(key, value);
  if (result.ok) return;

  if (result.validation.code !== "not-ready") return;
  if (runtime.getSnapshot().phase === "saving") {
    let unsubscribe: (() => void) | undefined;
    let scheduled = false;
    const retryWhenReady = () => {
      if (scheduled || runtime.getSnapshot().phase === "saving") return;
      scheduled = true;
      unsubscribe?.();
      queueMicrotask(() => stageContextSetting(runtime, key, value));
    };
    unsubscribe = runtime.subscribe(retryWhenReady);
    retryWhenReady();
    return;
  }

  runtime.fail(
    new AppFailure({
      code: "unavailable",
      message: result.validation.message,
      retryable: true,
    }),
  );
}

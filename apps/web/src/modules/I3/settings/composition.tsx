import type { ReactElement } from "react";
import type { MemorySettingsRuntimes } from "./controller";
import { MemorySettingsMount } from "./mount";

export function memorySettingsSurface(
  runtimes: MemorySettingsRuntimes,
  onClose?: () => void,
): ReactElement {
  return <MemorySettingsMount runtimes={runtimes} onClose={onClose} />;
}

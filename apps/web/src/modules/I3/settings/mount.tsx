import type { MemorySettingsRuntimes } from "./controller";
import { useMemorySettingsController } from "./controller";
import { MemorySettingsView } from "./view";

export function MemorySettingsMount({
  runtimes,
  onClose,
}: {
  readonly runtimes: MemorySettingsRuntimes;
  readonly onClose?: () => void;
}) {
  const controller = useMemorySettingsController(runtimes);
  return (
    <MemorySettingsView model={controller.model} actions={controller.actions} onClose={onClose} />
  );
}

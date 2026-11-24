import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { setLookScope, useLookScope } from "../look/sync";
import { usePhone } from "../phone";

/**
 * Settings → App → Look's switch (V258), as omp's settings switch between every folder and this one: the look below
 * for every device (kept on the server; each device on Every device changes with it) or for this device only.
 */
export function LookScopeSwitch(): ReactNode {
  const scope = useLookScope();
  const phone = usePhone();
  const item = `text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1 ${phone ? "h-10 flex-1 text-sm" : "h-6 px-2 text-xs tablet:h-11"}`;
  return (
    <div className={`flex gap-2 pb-1 ${phone ? "flex-col" : "items-center"}`}>
      <ToggleGroup
        aria-label="Whose look"
        size="sm"
        spacing={0.5}
        className={`rounded-lg border border-l2 p-0.5 ${phone ? "w-full" : ""}`}
        value={[scope === "device" ? "device" : "every"]}
        onValueChange={(next: string[]) => {
          if (next[0] !== undefined) setLookScope(next[0] === "device" ? "device" : "global");
        }}
      >
        <ToggleGroupItem value="every" className={item}>
          Every device
        </ToggleGroupItem>
        <ToggleGroupItem value="device" className={item}>
          This device
        </ToggleGroupItem>
      </ToggleGroup>
      <span className={`min-w-0 text-xs text-t3 ${phone ? "px-1" : ""}`}>
        {scope === "device"
          ? "Light or dark, the themes, the style, tool calls and idle workspaces: this device's own"
          : "Light or dark, the themes, the style, tool calls and idle workspaces: the same on every device set to Every device"}
      </span>
    </div>
  );
}

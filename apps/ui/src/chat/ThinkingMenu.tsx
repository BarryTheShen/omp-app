import { Brain } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatController, ThinkingLevelName } from "./controller";

/**
 * omp's thinking level for the chat's model (#2837): a menu of the levels omp offers for it, read each time it opens,
 * so one pick sets any of them instead of stepping through all. The key (Shift+Tab) still steps to the next one. On a
 * phone the menu comes up from the foot of the screen, as every menu does there.
 */
export function ThinkingMenu({
  controller,
  level,
  disabled,
  onError,
}: {
  readonly controller: ChatController;
  readonly level: string;
  readonly disabled: boolean;
  readonly onError: (failure: unknown) => void;
}): ReactNode {
  const [levels, setLevels] = useState<readonly ThinkingLevelName[] | null>(null);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) return;
        controller.thinkingLevels().then(setLevels, (failure: unknown) => {
          setLevels([]);
          onError(failure);
        });
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            data-tour="thinking"
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-t2 hover:text-t1 tablet:h-11"
            aria-label={`Thinking: ${level}`}
            disabled={disabled}
          />
        }
      >
        <Brain />
        {level}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-auto min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Thinking</DropdownMenuLabel>
          {levels === null ? (
            <p className="px-1.5 py-1 text-sm text-t3">Reading the levels…</p>
          ) : levels.length === 0 ? (
            <p className="px-1.5 py-1 text-sm text-t3">This model has no thinking levels.</p>
          ) : (
            <DropdownMenuRadioGroup
              value={level}
              onValueChange={(next: unknown) => {
                const picked = levels.find((name) => name === next);
                if (picked !== undefined && picked !== level)
                  void controller.setThinking(picked).catch(onError);
              }}
            >
              {levels.map((name) => (
                <DropdownMenuRadioItem key={name} value={name}>
                  {name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import type { ReactElement } from "react";
import type { DiffPanelProps } from "../diff";
import { DiffPanel } from "../diff";
import type { RestoreViewProps } from "./view";
import { RestoreView } from "./view";

export function workspaceRestoreSurface(
  diff: DiffPanelProps,
  restore: RestoreViewProps,
): ReactElement {
  return (
    <>
      <DiffPanel {...diff} />
      <RestoreView {...restore} />
    </>
  );
}

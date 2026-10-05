import type { ReactNode } from "react";
import type { OutputMeta } from "./contract";

export type CopyKind = "args" | "result" | "code";

export interface RawResultSlotProps {
  readonly raw: string;
  readonly meta?: OutputMeta;
  readonly className?: string;
}

export interface CopySlotProps {
  readonly raw: string;
  readonly kind: CopyKind;
  readonly disabled?: boolean;
  readonly onCopy: () => void | Promise<void>;
}

export interface DiffSlotProps {
  readonly before: string;
  readonly after: string;
  readonly language?: string;
  readonly className?: string;
}

export interface ArtifactSlotProps {
  readonly artifactId: string;
  readonly label?: string;
  readonly elidedBytes?: number;
  readonly error?: string;
  readonly onOpen: () => void | Promise<void>;
}

export type RawResultSlot = (props: RawResultSlotProps) => ReactNode;
export type CopySlot = (props: CopySlotProps) => ReactNode;
export type DiffSlot = (props: DiffSlotProps) => ReactNode;
export type ArtifactSlot = (props: ArtifactSlotProps) => ReactNode;

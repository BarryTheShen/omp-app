import { createContext } from "react";

/**
 * omp-app's addition: a pane's request to open or fold every tool card or every thinking block at once (Ctrl+O and
 * Ctrl+T). `epoch` counts the requests; 0 means none was made, so each card keeps its own default.
 */
export interface Fold {
	readonly open: boolean;
	readonly epoch: number;
}

export interface Folds {
	readonly tools: Fold;
	readonly thinking: Fold;
}

export const NO_FOLDS: Folds = { tools: { open: false, epoch: 0 }, thinking: { open: false, epoch: 0 } };

export const FoldContext = createContext<Folds>(NO_FOLDS);

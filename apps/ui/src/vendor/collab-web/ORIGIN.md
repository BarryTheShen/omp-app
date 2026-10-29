# Vendored: omp's collab-web

- **Source:** https://github.com/can1357/oh-my-pi, `packages/collab-web/src`, tag `v18.12.6` (commit `45c35e40c46166dc726ccc52f5d27f40f2449f99`). The same files are unchanged at `v18.13.3`.
- **Licence:** MIT, `LICENSE` in this folder (copied from the repository root).
- **Copied:** `components/transcript/{Transcript.tsx,Markdown.tsx,math.ts,ToolCard.tsx,transcript.css}`, `tool-render/` (without `element.tsx` and `standalone.tsx`), `lib/format.ts`. Not copied: `styles/tokens.css`; the app's themes set the variables collab-web reads (`src/styles/index.css`, the `.tr-root` block).
- **Local changes:**
  1. `components/transcript/Transcript.tsx` imports `ActiveTool` and `ConnectionPhase` from `lib/types.ts` (written here, copied from collab-web's `lib/client.ts`), because the guest client itself is not vendored.
  2. `tool-render/index.ts` no longer re-exports `./element` (the `<omp-tool-view>` web component is not used).
  3. `components/transcript/Transcript.tsx` exports `Row`, `AssistantBody` and `EntryRow`. omp-app draws these rows in its own list (`src/chat/TranscriptList.tsx`, on TanStack Virtual); collab-web's `Transcript` component and its scroll code are not used.

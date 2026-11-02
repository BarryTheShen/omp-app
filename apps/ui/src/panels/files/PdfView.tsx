import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type ReactNode, useEffect, useRef, useState } from "react";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Pages this far below or above the view are drawn ahead, so scrolling meets drawn pages. */
const DRAW_AHEAD = "600px 0px";

/** The element that scrolls the pages: the viewer's own scrolling area, or the page itself. */
function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

/**
 * A PDF drawn by the app with PDF.js (#2785), the same in every window: the desktop window showed a frame with the
 * file blank, and iOS shows no PDF inside a page. Each page is a canvas as wide as the panel, drawn when it comes
 * near the view; until then it holds its place at the first page's shape.
 */
export default function PdfView({
  bytes,
  name,
  onFailed,
}: {
  readonly bytes: Uint8Array;
  readonly name: string;
  /** PDF.js could not read or draw it: the viewer offers Open and Download instead. */
  readonly onFailed: (reason: string) => void;
}): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<number | null>(null);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let stopped = false;
    let observer: IntersectionObserver | null = null;
    const draw = async (
      pdf: PDFDocumentProxy,
      number: number,
      slot: HTMLElement,
    ): Promise<void> => {
      const page = await pdf.getPage(number);
      if (stopped) return;
      const width = Math.max(1, slot.clientWidth);
      const scale = (width / page.getViewport({ scale: 1 }).width) * window.devicePixelRatio;
      const viewport = page.getViewport({ scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = "block h-auto w-full";
      await page.render({ canvas, viewport }).promise;
      if (stopped) return;
      slot.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      slot.replaceChildren(canvas);
    };
    // PDF.js hands the bytes to its worker: it gets a copy, so the viewer keeps its own.
    const loading = getDocument({ data: bytes.slice() });
    loading.promise
      .then(async (pdf) => {
        if (stopped) return;
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (stopped) return;
        setPages(pdf.numPages);
        const drawn = new Set<number>();
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const number = Number((entry.target as HTMLElement).dataset.page);
              if (!entry.isIntersecting || drawn.has(number)) continue;
              drawn.add(number);
              draw(pdf, number, entry.target as HTMLElement).catch((failure: unknown) => {
                if (!stopped)
                  onFailed(failure instanceof Error ? failure.message : String(failure));
              });
            }
          },
          { root: scrollParentOf(element), rootMargin: DRAW_AHEAD },
        );
        const slots = Array.from({ length: pdf.numPages }, (_, index) => {
          const slot = window.document.createElement("div");
          slot.dataset.page = String(index + 1);
          slot.setAttribute("role", "img");
          slot.setAttribute("aria-label", `Page ${index + 1} of ${pdf.numPages}`);
          slot.className = "w-full bg-white shadow-sm";
          slot.style.aspectRatio = `${first.width} / ${first.height}`;
          return slot;
        });
        element.replaceChildren(...slots);
        for (const slot of slots) observer.observe(slot);
      })
      .catch((failure: unknown) => {
        if (!stopped) onFailed(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      stopped = true;
      observer?.disconnect();
      void loading.destroy();
      // Destroying the loading task closes the document and its worker.
    };
  }, [bytes, onFailed]);

  return (
    <div role="document" aria-label={name} className="flex flex-col gap-2 p-2">
      {pages === null && <p className="text-sm text-t3">Drawing the PDF…</p>}
      <div ref={host} className="flex flex-col gap-2" />
    </div>
  );
}

import { Minus, MoveHorizontal, Plus } from "lucide-react";
import {
  GlobalWorkerOptions,
  getDocument,
  PDFDataRangeTransport,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Pages this far below or above the view are drawn ahead, so scrolling meets drawn pages. */
const DRAW_AHEAD = "600px 0px";
/** The PDF's own zoom: 1 fits a page to the panel's width; pinch and the buttons go up to 4. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
/** Each press of Zoom in or Zoom out. */
const ZOOM_STEP = 1.25;

/** A zoom kept within its bounds. */
function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
/** Pixels per CSS pixel a page is drawn with at least: sharp on a 1x screen too, and when pinch-zoomed. */
const MIN_PIXEL_RATIO = 2;
/** The most pixels one page's canvas gets: WebKit (iOS) draws nothing on a canvas above about 16.7 million. */
const MAX_CANVAS_PIXELS = 16_000_000;
/** How long the panel's width and the screen's density must hold before drawn pages are drawn again. */
const REDRAW_AFTER_MS = 200;
/** A drawn page is drawn again when its canvas has less than this share of the pixels its place needs now. */
const REDRAW_BELOW = 0.95;
/**
 * The bytes PDF.js asks for at a time (its own default). Small, because before the first page PDF.js looks up the last
 * one, which in a flat page list means reading every page's entry: with 512 KB a read, a 40-page scan cost 21 MB first.
 */
const RANGE_CHUNK = 64 * 1024;

/** A PDF's bytes, read as PDF.js asks for them: its size, and any part of it. */
export interface PdfSource {
  readonly size: number;
  readonly read: (begin: number, end: number) => Promise<Uint8Array>;
}

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
 * near the view; until then it holds its place at the first page's shape. A drawn page is drawn again when the panel
 * grows or the screen's density changes (zoom, another screen): one drawn for a narrower panel was stretched, blurred.
 * PDF.js reads only the parts of the file it needs, as it needs them: the file's index and the pages drawn, so the
 * first page of a large PDF shows after a few reads, not after the whole file came over the link.
 */
export default function PdfView({
  source,
  name,
  onFailed,
}: {
  readonly source: PdfSource;
  readonly name: string;
  /** PDF.js could not read or draw it: the viewer offers Open and Download instead. */
  readonly onFailed: (reason: string) => void;
}): ReactNode {
  const root = useRef<HTMLDivElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const zoomNow = useRef(MIN_ZOOM);

  /**
   * Sets the PDF's zoom (the pages' width against the panel's), keeping the point `at` (a screen point; the middle of
   * the view without one) where it is. The pages are drawn again, sharp, once the new width holds.
   */
  const zoomTo = useCallback((next: number, at?: { readonly x: number; readonly y: number }) => {
    const element = host.current;
    if (element === null) return;
    const before = zoomNow.current;
    const after = clampZoom(next);
    if (after === before) return;
    const scroller = scrollParentOf(element);
    const box = scroller?.getBoundingClientRect();
    const anchor =
      box === undefined
        ? { x: 0, y: 0 }
        : at === undefined
          ? { x: box.width / 2, y: box.height / 2 }
          : { x: at.x - box.left, y: at.y - box.top };
    const left = (scroller?.scrollLeft ?? 0) + anchor.x;
    const top = (scroller?.scrollTop ?? 0) + anchor.y;
    zoomNow.current = after;
    element.style.width = `${after * 100}%`;
    if (scroller !== null) {
      scroller.scrollLeft = (left * after) / before - anchor.x;
      scroller.scrollTop = (top * after) / before - anchor.y;
    }
    setZoom(after);
  }, []);

  // Two fingers zoom the PDF, not the screen: the screen's own zoom (stopped by `touch-action` below) took the viewer's
  // Back off the screen on an iPhone, with no way back but pinching out (#93).
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    let start: { readonly distance: number; readonly zoom: number } | null = null;
    const fingers = (touches: TouchList) => {
      const a = touches.item(0);
      const b = touches.item(1);
      if (a === null || b === null) return null;
      return {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        middle: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      };
    };
    const onStart = (event: TouchEvent): void => {
      const two = event.touches.length === 2 ? fingers(event.touches) : null;
      start =
        two === null || two.distance === 0
          ? null
          : { distance: two.distance, zoom: zoomNow.current };
    };
    const onMove = (event: TouchEvent): void => {
      if (start === null || event.touches.length !== 2) return;
      const two = fingers(event.touches);
      if (two !== null) zoomTo((start.zoom * two.distance) / start.distance, two.middle);
    };
    const onEnd = (event: TouchEvent): void => {
      if (event.touches.length < 2) start = null;
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: true });
    element.addEventListener("touchend", onEnd, { passive: true });
    element.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  }, [zoomTo]);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let stopped = false;
    let observer: IntersectionObserver | null = null;
    let resized: ResizeObserver | null = null;
    let redrawTimer: ReturnType<typeof setTimeout> | null = null;
    /** Each drawn page's latest draw: an older one that ends later does not replace it. */
    const draws = new Map<number, number>();
    const ratio = (): number => Math.max(window.devicePixelRatio, MIN_PIXEL_RATIO);
    const draw = async (
      pdf: PDFDocumentProxy,
      number: number,
      slot: HTMLElement,
    ): Promise<void> => {
      const turn = (draws.get(number) ?? 0) + 1;
      draws.set(number, turn);
      const page = await pdf.getPage(number);
      if (stopped || draws.get(number) !== turn) return;
      const width = Math.max(1, slot.clientWidth);
      const natural = page.getViewport({ scale: 1 });
      let scale = (width / natural.width) * ratio();
      const pixels = natural.width * natural.height * scale * scale;
      if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = "block h-auto w-full";
      await page.render({ canvas, viewport }).promise;
      if (stopped || draws.get(number) !== turn) return;
      slot.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      slot.replaceChildren(canvas);
    };
    /** Draws again each drawn page whose canvas has too few pixels for its place now. */
    const redrawSharp = (pdf: PDFDocumentProxy): void => {
      for (const slot of element.querySelectorAll<HTMLElement>("[data-page]")) {
        const canvas = slot.querySelector("canvas");
        if (canvas === null) continue;
        const needed = Math.min(slot.clientWidth * ratio(), Math.sqrt(MAX_CANVAS_PIXELS));
        if (canvas.width >= needed * REDRAW_BELOW) continue;
        draw(pdf, Number(slot.dataset.page), slot).catch((failure: unknown) => {
          if (!stopped) onFailed(failure instanceof Error ? failure.message : String(failure));
        });
      }
    };
    const watchDensity = (pdf: PDFDocumentProxy): void => {
      // Fires once when the density leaves this value (zoom, another screen); then it watches the new one.
      window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
        "change",
        () => {
          if (stopped) return;
          redrawSharp(pdf);
          watchDensity(pdf);
        },
        { once: true },
      );
    };
    // PDF.js asks for the parts it needs (the file's index at its end, then each drawn page's objects), and only those:
    // no fetching of the rest ahead, which on a phone would hold the whole file in memory for pages never looked at.
    const transport = new PDFDataRangeTransport(source.size, null);
    transport.requestDataRange = (begin: number, end: number): void => {
      source.read(begin, end).then(
        (chunk) => {
          if (!stopped) transport.onDataRange(begin, chunk);
        },
        (failure: unknown) => {
          if (!stopped) onFailed(failure instanceof Error ? failure.message : String(failure));
        },
      );
    };
    const loading = getDocument({
      range: transport,
      rangeChunkSize: RANGE_CHUNK,
      disableAutoFetch: true,
      disableStream: true,
    });
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
        // The panel grew (or the window, or the app's zoom changed its width): drawn pages are drawn again once it holds.
        let width = element.clientWidth;
        resized = new ResizeObserver(() => {
          if (element.clientWidth <= width) return;
          width = element.clientWidth;
          if (redrawTimer !== null) clearTimeout(redrawTimer);
          redrawTimer = setTimeout(() => {
            redrawTimer = null;
            if (!stopped) redrawSharp(pdf);
          }, REDRAW_AFTER_MS);
        });
        resized.observe(element);
        watchDensity(pdf);
      })
      .catch((failure: unknown) => {
        if (!stopped) onFailed(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      stopped = true;
      observer?.disconnect();
      resized?.disconnect();
      if (redrawTimer !== null) clearTimeout(redrawTimer);
      void loading.destroy();
      // Destroying the loading task closes the document and its worker.
    };
  }, [source, onFailed]);

  return (
    <div
      ref={root}
      role="document"
      aria-label={name}
      className="flex touch-pan-x touch-pan-y flex-col gap-2 p-2"
    >
      {pages === null && <p className="text-sm text-t3">Drawing the PDF…</p>}
      {pages !== null && (
        <div
          role="toolbar"
          aria-label="Zoom"
          className="sticky top-0 left-0 z-10 flex w-fit items-center gap-0.5 self-start rounded-md border border-l2 bg-l1 p-0.5 shadow-sm"
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomTo(zoom / ZOOM_STEP)}
          >
            <Minus />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Fit to width (now ${Math.round(zoom * 100)}%)`}
            disabled={zoom === MIN_ZOOM}
            onClick={() => zoomTo(MIN_ZOOM)}
          >
            <MoveHorizontal /> {Math.round(zoom * 100)}%
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomTo(zoom * ZOOM_STEP)}
          >
            <Plus />
          </Button>
        </div>
      )}
      <div ref={host} className="flex flex-col gap-2" style={{ width: `${zoom * 100}%` }} />
    </div>
  );
}

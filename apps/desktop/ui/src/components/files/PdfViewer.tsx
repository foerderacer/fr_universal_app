import {
  ChevronLeft,
  ChevronRight,
  MoveHorizontal,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "../ui/Tooltip";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfViewerProps {
  url: string;
  fileName: string;
  onFallbackNote?: string;
}

export function PdfViewer({ url, fileName, onFallbackNote }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [loadError, setLoadError] = useState<{
    message: string;
    details: string | null;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchPages, setMatchPages] = useState<number[]>([]);
  const [searching, setSearching] = useState(false);
  const searchRunRef = useRef(0);
  const autoFitRef = useRef(true);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  pdfDocRef.current = pdfDoc;
  const pageNumRef = useRef(pageNum);
  pageNumRef.current = pageNum;

  const fitToWidth = useCallback(
    async (doc: pdfjsLib.PDFDocumentProxy | null, targetPage: number) => {
      if (!doc || !containerRef.current) return;
      const availableWidth = containerRef.current.clientWidth - 28;
      if (availableWidth <= 100) return;
      try {
        const page = await doc.getPage(targetPage);
        const baseViewport = page.getViewport({ scale: 1 });
        if (baseViewport.width > 0) {
          const computed = Math.max(
            0.4,
            Math.min(2.5, Number((availableWidth / baseViewport.width).toFixed(2))),
          );
          setScale(computed);
        }
      } catch {
        // Ignore fit calculation failure on destroyed document.
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    searchRunRef.current += 1;
    setLoadError(null);
    setPdfDoc(null);
    setPageNum(1);
    setNumPages(0);
    setMatchPages([]);
    setSearching(false);

    const task = pdfjsLib.getDocument({ url });
    autoFitRef.current = true;
    task.promise
      .then((doc) => {
        if (cancelled) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        void fitToWidth(doc, 1);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError({
            message:
              onFallbackNote ??
              `We couldn't display "${fileName}" right now. Open in native app to view it.`,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      });

    return () => {
      cancelled = true;
      searchRunRef.current += 1;
      void task.destroy();
    };
  }, [url, fileName, onFallbackNote, fitToWidth]);

  // Re-fit PDF width live when the Files inspector pane is resized (until manual zoom)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (autoFitRef.current && pdfDocRef.current) {
        void fitToWidth(pdfDocRef.current, pageNumRef.current);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitToWidth]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    void pdfDoc.getPage(pageNum).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      renderTask = page.render({
        canvasContext: ctx,
        canvas,
        viewport,
      });
      void renderTask.promise.catch(() => {});
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNum, scale]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!pdfDoc) return;
    const runId = ++searchRunRef.current;
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) {
      setMatchPages([]);
      return;
    }
    setSearching(true);
    try {
      const hits: number[] = [];
      for (let p = 1; p <= pdfDoc.numPages; p += 1) {
        if (searchRunRef.current !== runId) return;
        const page = await pdfDoc.getPage(p);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .toLowerCase();
        if (text.includes(needle)) hits.push(p);
      }
      if (searchRunRef.current !== runId) return;
      setMatchPages(hits);
      if (hits.length > 0) setPageNum(hits[0]);
    } finally {
      if (searchRunRef.current === runId) setSearching(false);
    }
  }

  if (loadError) {
    return (
      <div className="rounded-md border border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] p-3.5 text-xs text-[var(--text-primary)]">
        <p>{loadError.message}</p>
        {loadError.details && (
          <details className="mt-2 text-[11px] text-[var(--text-muted)]">
            <summary className="cursor-pointer font-medium">Technical details</summary>
            <p className="mono-num mt-1 break-all">{loadError.details}</p>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex h-8 shrink-0 flex-nowrap items-center justify-between gap-1.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5">
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            size="xs"
            label="Previous page"
            disabled={pageNum <= 1}
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <span className="mono-num px-1 whitespace-nowrap text-[11px] text-[var(--text-secondary)]">
            {numPages ? pageNum : "—"} / {numPages || "—"}
          </span>
          <IconButton
            size="xs"
            label="Next page"
            disabled={pageNum >= numPages}
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
          >
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>

        <form
          onSubmit={(e) => void handleSearch(e)}
          className="flex min-w-0 flex-1 items-center justify-center gap-1"
        >
          <div className="relative min-w-0 flex-1 max-w-[132px]">
            <Search
              className="pointer-events-none absolute top-1/2 left-1.5 h-3 w-3 -translate-y-1/2 text-[var(--text-muted)]"
              strokeWidth={1.5}
            />
            <input
              type="text"
              aria-label="Search PDF text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find…"
              className="h-6 w-full min-w-0 rounded border border-[var(--border-strong)] bg-[var(--bg-app)] pr-1.5 pl-5 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>
          {matchPages.length > 0 && (
            <span className="mono-num shrink-0 text-[11px] text-[var(--accent-text)]">
              {matchPages.length}p
            </span>
          )}
          {searching && (
            <span className="shrink-0 text-[11px] text-[var(--text-muted)]">…</span>
          )}
        </form>

        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            size="xs"
            label="Fit to width"
            disabled={!pdfDoc}
            onClick={() => {
              autoFitRef.current = true;
              void fitToWidth(pdfDoc, pageNum);
            }}
          >
            <MoveHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            size="xs"
            label="Zoom out"
            onClick={() => {
              autoFitRef.current = false;
              setScale((s) => Math.max(0.4, Number((s - 0.15).toFixed(2))));
            }}
          >
            <ZoomOut className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <span className="mono-num w-9 text-center text-[11px] text-[var(--text-secondary)]">
            {Math.round(scale * 100)}%
          </span>
          <IconButton
            size="xs"
            label="Zoom in"
            onClick={() => {
              autoFitRef.current = false;
              setScale((s) => Math.min(3, Number((s + 0.15).toFixed(2))));
            }}
          >
            <ZoomIn className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex flex-1 items-start justify-center overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-app)] p-3"
      >
        {!pdfDoc ? (
          <p className="py-10 text-xs text-[var(--text-muted)]">
            Loading document…
          </p>
        ) : (
          <canvas
            ref={canvasRef}
            className="rounded border border-[var(--border-hairline)] bg-white"
          />
        )}
      </div>
    </div>
  );
}

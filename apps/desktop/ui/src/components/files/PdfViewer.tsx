import { ChevronLeft, ChevronRight, Search, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchPages, setMatchPages] = useState<number[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setPdfDoc(null);
    setPageNum(1);
    setNumPages(0);
    setMatchPages([]);

    const task = pdfjsLib.getDocument({ url });
    task.promise
      .then((doc) => {
        if (cancelled) {
          return;
        }
        setPdfDoc(doc);
        setNumPages(doc.numPages);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            onFallbackNote ??
              `Unable to render ${fileName} as PDF (${err instanceof Error ? err.message : String(err)}).`,
          );
        }
      });

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url, fileName, onFallbackNote]);

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
      void renderTask.promise.catch(() => {
        // Ignore cancelled renders when paging or zooming quickly.
      });
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNum, scale]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!pdfDoc) return;
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) {
      setMatchPages([]);
      return;
    }
    setSearching(true);
    try {
      const hits: number[] = [];
      for (let p = 1; p <= pdfDoc.numPages; p += 1) {
        const page = await pdfDoc.getPage(p);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .toLowerCase();
        if (text.includes(needle)) {
          hits.push(p);
        }
      }
      setMatchPages(hits);
      if (hits.length > 0) {
        setPageNum(hits[0]);
      }
    } finally {
      setSearching(false);
    }
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
        {loadError}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={pageNum <= 1}
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
            Page {numPages ? pageNum : "—"} / {numPages || "—"}
          </span>
          <button
            type="button"
            disabled={pageNum >= numPages}
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSearch(e)} className="flex items-center gap-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find text..."
              className="w-36 rounded-lg border border-slate-300 bg-white py-1 pr-2 pl-7 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          {matchPages.length > 0 && (
            <span className="text-[11px] text-blue-600 dark:text-blue-400">
              {matchPages.length} pg{matchPages.length === 1 ? "" : "s"}
            </span>
          )}
          {searching && (
            <span className="text-[11px] text-slate-400">Searching...</span>
          )}
        </form>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.5, Number((s - 0.2).toFixed(2))))}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="w-11 text-center text-xs font-medium text-slate-600 dark:text-slate-300">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(3, Number((s + 0.2).toFixed(2))))}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 items-start justify-center overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-4 dark:border-slate-800 dark:bg-slate-950">
        {!pdfDoc ? (
          <p className="py-12 text-xs text-slate-500">Loading document...</p>
        ) : (
          <canvas
            ref={canvasRef}
            className="rounded-md bg-white shadow-md"
          />
        )}
      </div>
    </div>
  );
}

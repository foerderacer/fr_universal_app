import DOMPurify from "dompurify";
import DxfParser from "dxf-parser";
import { ZoomIn, ZoomOut } from "lucide-react";
import { useMemo, useState } from "react";

interface SvgViewerProps {
  svgText: string;
}

export function SvgViewer({ svgText }: SvgViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [bg, setBg] = useState<"checker" | "light" | "dark">("checker");

  const sanitizedSvg = useMemo(
    () =>
      DOMPurify.sanitize(svgText, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["script", "foreignObject"],
      }),
    [svgText],
  );

  const bgClass =
    bg === "dark"
      ? "bg-slate-900"
      : bg === "light"
        ? "bg-white"
        : "fr-checkerboard";

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-1">
          {(["checker", "light", "dark"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setBg(mode)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize ${
                bg === mode
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.25, Number((z - 0.25).toFixed(2))))}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="w-12 text-center text-xs font-medium text-slate-600 dark:text-slate-300">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(5, Number((z + 0.25).toFixed(2))))}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className={`flex flex-1 items-center justify-center overflow-auto rounded-xl border border-slate-200 p-6 dark:border-slate-800 ${bgClass}`}
      >
        <div
          style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
          className="max-h-full max-w-full transition-transform"
          dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
        />
      </div>
    </div>
  );
}

interface DxfViewerProps {
  dxfText: string;
}

interface DxfPoint {
  x: number;
  y: number;
}

interface ParsedDxfEntity {
  type: string;
  vertices?: DxfPoint[];
  center?: DxfPoint;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  shape?: boolean;
}

export function DxfViewer({ dxfText }: DxfViewerProps) {
  const [zoom, setZoom] = useState(1);

  const rendered = useMemo(() => {
    try {
      const parser = new DxfParser();
      const dxf = parser.parseSync(dxfText);
      const entities = (dxf?.entities ?? []) as ParsedDxfEntity[];
      if (entities.length === 0) {
        return { error: "No supported 2D entities found in this DXF file.", elements: [], viewBox: "0 0 100 100" };
      }

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const track = (x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        minX = Math.min(minX, x);
        minY = Math.min(minY, -y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, -y);
      };

      const elements: Array<{ key: string; kind: "path" | "circle"; d?: string; cx?: number; cy?: number; r?: number }> = [];

      entities.forEach((ent, idx) => {
        if (ent.type === "LINE" && ent.vertices && ent.vertices.length >= 2) {
          const [a, b] = ent.vertices;
          track(a.x, a.y);
          track(b.x, b.y);
          elements.push({
            key: `l-${idx}`,
            kind: "path",
            d: `M ${a.x} ${-a.y} L ${b.x} ${-b.y}`,
          });
        } else if (
          (ent.type === "LWPOLYLINE" || ent.type === "POLYLINE") &&
          ent.vertices &&
          ent.vertices.length >= 2
        ) {
          const pts = ent.vertices;
          pts.forEach((p) => track(p.x, p.y));
          const cmd = pts
            .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${-p.y}`)
            .join(" ");
          elements.push({
            key: `p-${idx}`,
            kind: "path",
            d: ent.shape ? `${cmd} Z` : cmd,
          });
        } else if (ent.type === "CIRCLE" && ent.center && ent.radius) {
          track(ent.center.x - ent.radius, ent.center.y - ent.radius);
          track(ent.center.x + ent.radius, ent.center.y + ent.radius);
          elements.push({
            key: `c-${idx}`,
            kind: "circle",
            cx: ent.center.x,
            cy: -ent.center.y,
            r: ent.radius,
          });
        } else if (
          ent.type === "ARC" &&
          ent.center &&
          ent.radius &&
          ent.startAngle !== undefined &&
          ent.endAngle !== undefined
        ) {
          const cx = ent.center.x;
          const cy = ent.center.y;
          const r = ent.radius;
          const sx = cx + r * Math.cos(ent.startAngle);
          const sy = cy + r * Math.sin(ent.startAngle);
          const ex = cx + r * Math.cos(ent.endAngle);
          const ey = cy + r * Math.sin(ent.endAngle);
          track(cx - r, cy - r);
          track(cx + r, cy + r);
          let sweep = ent.endAngle - ent.startAngle;
          if (sweep < 0) sweep += Math.PI * 2;
          const largeArc = sweep > Math.PI ? 1 : 0;
          elements.push({
            key: `a-${idx}`,
            kind: "path",
            d: `M ${sx} ${-sy} A ${r} ${r} 0 ${largeArc} 0 ${ex} ${-ey}`,
          });
        }
      });

      if (!Number.isFinite(minX)) {
        return { error: "DXF geometry bounds could not be computed.", elements: [], viewBox: "0 0 100 100" };
      }

      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const pad = Math.max(w, h) * 0.08;
      return {
        error: null,
        elements,
        viewBox: `${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`,
        strokeWidth: Math.max(w, h) * 0.003,
      };
    } catch (err) {
      return {
        error: `Could not parse DXF (${err instanceof Error ? err.message : String(err)}).`,
        elements: [],
        viewBox: "0 0 100 100",
        strokeWidth: 1,
      };
    }
  }, [dxfText]);

  if (rendered.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
        {rendered.error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
          2D CAD Vector ({rendered.elements.length} primitives)
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="w-12 text-center text-xs font-medium text-slate-600 dark:text-slate-300">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(6, Number((z + 0.25).toFixed(2))))}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-4 dark:border-slate-800">
        <svg
          viewBox={rendered.viewBox}
          style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
          className="h-full max-h-[520px] w-full transition-transform"
        >
          {rendered.elements.map((el) =>
            el.kind === "circle" ? (
              <circle
                key={el.key}
                cx={el.cx}
                cy={el.cy}
                r={el.r}
                fill="none"
                stroke="#38bdf8"
                strokeWidth={rendered.strokeWidth}
              />
            ) : (
              <path
                key={el.key}
                d={el.d}
                fill="none"
                stroke="#38bdf8"
                strokeWidth={rendered.strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ),
          )}
        </svg>
      </div>
    </div>
  );
}

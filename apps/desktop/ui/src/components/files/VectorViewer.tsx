import DOMPurify from "dompurify";
import DxfParser from "dxf-parser";
import { Grid2x2, Moon, Sun, ZoomIn, ZoomOut } from "lucide-react";
import { useMemo, useState } from "react";
import { IconButton } from "../ui/Tooltip";

interface SvgViewerProps {
  svgText: string;
}

const SAFE_SVG_DATA_IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,/i;

function sanitizeSvgStrict(rawSvg: string): string {
  const hook = (node: Element) => {
    for (const attr of ["href", "xlink:href", "src"]) {
      const val = node.getAttribute(attr);
      if (val === null) continue;
      const trimmed = val.trim();
      const allowed =
        trimmed.startsWith("#") || SAFE_SVG_DATA_IMAGE_RE.test(trimmed);
      if (!allowed) node.removeAttribute(attr);
    }
    const styleAttr = node.getAttribute("style");
    if (styleAttr && /url\s*\(/i.test(styleAttr)) {
      node.removeAttribute("style");
    }
  };

  DOMPurify.addHook("afterSanitizeAttributes", hook);
  try {
    return DOMPurify.sanitize(rawSvg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: [
        "script",
        "foreignObject",
        "style",
        "a",
        "iframe",
        "object",
        "embed",
        "animate",
        "set",
      ],
    });
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}

export function SvgViewer({ svgText }: SvgViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [bg, setBg] = useState<"checker" | "light" | "dark">("checker");

  const sanitizedSvg = useMemo(() => sanitizeSvgStrict(svgText), [svgText]);

  const bgClass =
    bg === "dark"
      ? "bg-[var(--bg-viewport)]"
      : bg === "light"
        ? "bg-[var(--bg-surface)]"
        : "fr-checkerboard";

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1">
        <div className="flex items-center gap-0.5">
          <IconButton
            size="xs"
            label="Checkerboard backdrop"
            active={bg === "checker"}
            onClick={() => setBg("checker")}
          >
            <Grid2x2 className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            size="xs"
            label="Light backdrop"
            active={bg === "light"}
            onClick={() => setBg("light")}
          >
            <Sun className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <IconButton
            size="xs"
            label="Dark backdrop"
            active={bg === "dark"}
            onClick={() => setBg("dark")}
          >
            <Moon className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>

        <div className="flex items-center gap-0.5">
          <IconButton
            size="xs"
            label="Zoom out"
            onClick={() =>
              setZoom((z) => Math.max(0.25, Number((z - 0.25).toFixed(2))))
            }
          >
            <ZoomOut className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <span className="mono-num w-10 text-center text-[11px] text-[var(--text-secondary)]">
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            size="xs"
            label="Zoom in"
            onClick={() =>
              setZoom((z) => Math.min(5, Number((z + 0.25).toFixed(2))))
            }
          >
            <ZoomIn className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      <div
        className={`flex flex-1 items-center justify-center overflow-auto rounded-md border border-[var(--border-hairline)] p-5 ${bgClass}`}
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
        return {
          error: "This DXF drawing doesn't contain any previewable 2D shapes.",
          technicalDetails: null as string | null,
          elements: [],
          viewBox: "0 0 100 100",
          strokeWidth: 1,
        };
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

      const elements: Array<{
        key: string;
        kind: "path" | "circle";
        d?: string;
        cx?: number;
        cy?: number;
        r?: number;
      }> = [];

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
        return {
          error: "We couldn't calculate drawing bounds for this DXF file.",
          technicalDetails: null as string | null,
          elements: [],
          viewBox: "0 0 100 100",
          strokeWidth: 1,
        };
      }

      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const pad = Math.max(w, h) * 0.08;
      return {
        error: null,
        technicalDetails: null as string | null,
        elements,
        viewBox: `${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`,
        strokeWidth: Math.max(w, h) * 0.003,
      };
    } catch (err) {
      return {
        error:
          'We couldn\'t preview this DXF drawing in the app. Open in native app to view it in CAD.',
        technicalDetails: err instanceof Error ? err.message : String(err),
        elements: [],
        viewBox: "0 0 100 100",
        strokeWidth: 1,
      };
    }
  }, [dxfText]);

  if (rendered.error) {
    return (
      <div className="rounded-md border border-[var(--status-warning)]/35 bg-[var(--status-warning-soft)] p-3.5 text-xs text-[var(--text-primary)]">
        <p>{rendered.error}</p>
        {rendered.technicalDetails && (
          <details className="mt-2 text-[11px] text-[var(--text-muted)]">
            <summary className="cursor-pointer font-medium">Technical details</summary>
            <p className="mono-num mt-1 break-all">{rendered.technicalDetails}</p>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1">
        <span className="mono-num text-[11px] text-[var(--text-secondary)]">
          DXF · {rendered.elements.length} primitives
        </span>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="xs"
            label="Zoom out"
            onClick={() =>
              setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))
            }
          >
            <ZoomOut className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
          <span className="mono-num w-10 text-center text-[11px] text-[var(--text-secondary)]">
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            size="xs"
            label="Zoom in"
            onClick={() =>
              setZoom((z) => Math.min(6, Number((z + 0.25).toFixed(2))))
            }
          >
            <ZoomIn className="h-3.5 w-3.5" strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-viewport)] p-4">
        <svg
          viewBox={rendered.viewBox}
          style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
          className="h-full max-h-full w-full transition-transform"
        >
          {rendered.elements.map((el) =>
            el.kind === "circle" ? (
              <circle
                key={el.key}
                cx={el.cx}
                cy={el.cy}
                r={el.r}
                fill="none"
                stroke="var(--accent-vector)"
                strokeWidth={rendered.strokeWidth}
              />
            ) : (
              <path
                key={el.key}
                d={el.d}
                fill="none"
                stroke="var(--accent-vector)"
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

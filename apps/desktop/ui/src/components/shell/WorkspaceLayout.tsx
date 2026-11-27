import { PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { suppressNextFocusTooltip } from "../../lib/shortcuts";
import { IconButton } from "../ui/Tooltip";

export interface WorkspaceLayoutProps {
  moduleId?: string;
  headerLeft: React.ReactNode;
  headerRight?: React.ReactNode;
  sidebar?: React.ReactNode;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  inspector?: React.ReactNode;
  inspectorOpen: boolean;
  onToggleInspector?: () => void;
  inspectorLabel?: string;
  inspectorToggleLabel?: string;
  inspectorToggleShortcut?: string;
  inspectorExpanded?: boolean;
  inspectorDefaultWidth?: number;
  canvasMode?: "edge" | "document";
  banners?: React.ReactNode;
  children: React.ReactNode;
}

const PANE_WIDTHS_KEY = "fr.workspace.paneWidths.v1";
const DEFAULT_SIDEBAR_WIDTH = 228;
const DEFAULT_INSPECTOR_WIDTH = 400;
const RAIL_WIDTH_PX = 48;

interface ModulePaneWidths {
  sidebar?: number;
  inspector?: number;
}

function readPaneWidthsMap(): Record<string, ModulePaneWidths> {
  try {
    const raw = window.localStorage.getItem(PANE_WIDTHS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, ModulePaneWidths>;
    }
  } catch {
    // Ignore storage access errors in restricted webviews.
  }
  return {};
}

function writeModulePaneWidth(
  moduleId: string,
  pane: "sidebar" | "inspector",
  width: number,
) {
  try {
    const map = readPaneWidthsMap();
    map[moduleId] = { ...(map[moduleId] ?? {}), [pane]: width };
    window.localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write errors.
  }
}

function readModuleWidth(
  moduleId: string,
  pane: "sidebar" | "inspector",
  fallback: number,
  min: number,
  max: number,
): number {
  const val = readPaneWidthsMap()[moduleId]?.[pane];
  if (typeof val === "number" && Number.isFinite(val) && val >= min && val <= max) {
    return val;
  }
  return fallback;
}

export function WorkspaceLayout({
  moduleId = "default",
  headerLeft,
  headerRight,
  sidebar,
  sidebarOpen = false,
  onToggleSidebar,
  inspector,
  inspectorOpen,
  onToggleInspector,
  inspectorLabel = "Details inspector",
  inspectorToggleLabel,
  inspectorToggleShortcut,
  inspectorExpanded = false,
  inspectorDefaultWidth = DEFAULT_INSPECTOR_WIDTH,
  canvasMode = "edge",
  banners,
  children,
}: WorkspaceLayoutProps) {
  const sidebarPaneId = useId();
  const inspectorPaneId = useId();
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readModuleWidth(moduleId, "sidebar", DEFAULT_SIDEBAR_WIDTH, 188, 340),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readModuleWidth(moduleId, "inspector", inspectorDefaultWidth, 280, 760),
  );

  const [isDragging, setIsDragging] = useState(false);
  const dragModeRef = useRef<"sidebar" | "inspector" | null>(null);
  const moduleIdRef = useRef(moduleId);
  moduleIdRef.current = moduleId;
  const latestSidebarRef = useRef(sidebarWidth);
  latestSidebarRef.current = sidebarWidth;
  const latestInspectorRef = useRef(inspectorWidth);
  latestInspectorRef.current = inspectorWidth;
  const showSidebarRef = useRef(false);
  const showInspectorRef = useRef(false);

  // Sync per-module persisted widths and clamp against current window width so <main> never crushes
  useEffect(() => {
    const clampToWindow = (sb: number, ins: number) => {
      const MIN_MAIN_WIDTH = 340;
      const avail = Math.max(640, window.innerWidth - RAIL_WIDTH_PX);
      const clampedSb = Math.max(188, Math.min(340, sb));
      const maxIns = Math.min(
        760,
        Math.max(280, avail - clampedSb - MIN_MAIN_WIDTH),
      );
      const clampedIns = Math.max(280, Math.min(maxIns, ins));
      setSidebarWidth(clampedSb);
      setInspectorWidth(clampedIns);
    };

    clampToWindow(
      readModuleWidth(moduleId, "sidebar", DEFAULT_SIDEBAR_WIDTH, 188, 340),
      readModuleWidth(moduleId, "inspector", inspectorDefaultWidth, 280, 760),
    );

    const onResize = () => {
      setViewportWidth(window.innerWidth);
      clampToWindow(latestSidebarRef.current, latestInspectorRef.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [moduleId, inspectorDefaultWidth]);

  useEffect(() => {
    const MIN_MAIN_WIDTH = 340;
    const onMove = (e: MouseEvent) => {
      if (!dragModeRef.current) return;
      const avail = Math.max(640, window.innerWidth - RAIL_WIDTH_PX);
      if (dragModeRef.current === "inspector") {
        const maxInspector = Math.min(
          760,
          Math.max(
            280,
            avail -
              (showSidebarRef.current ? latestSidebarRef.current : 0) -
              MIN_MAIN_WIDTH,
          ),
        );
        const next = Math.max(
          280,
          Math.min(maxInspector, window.innerWidth - e.clientX),
        );
        setInspectorWidth(next);
      } else {
        const maxSidebar = Math.min(
          340,
          Math.max(
            188,
            avail -
              (showInspectorRef.current ? latestInspectorRef.current : 0) -
              MIN_MAIN_WIDTH,
          ),
        );
        const next = Math.max(
          188,
          Math.min(maxSidebar, e.clientX - RAIL_WIDTH_PX),
        );
        setSidebarWidth(next);
      }
    };
    const onUp = () => {
      if (!dragModeRef.current) return;
      const mode = dragModeRef.current;
      dragModeRef.current = null;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writeModulePaneWidth(
        moduleIdRef.current,
        mode,
        mode === "sidebar"
          ? latestSidebarRef.current
          : latestInspectorRef.current,
      );
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const hasSidebar = Boolean(sidebar);
  const hasInspector = Boolean(inspector);
  const showInspector = hasInspector && inspectorOpen;
  // Gate expanded preview on showInspector so collapsing the inspector never leaves a blank canvas
  const effectiveExpanded = inspectorExpanded && showInspector;
  const showSidebar = hasSidebar && sidebarOpen && !effectiveExpanded;
  showSidebarRef.current = showSidebar;
  showInspectorRef.current = showInspector;

  const sidebarToggleRef = useRef<HTMLSpanElement | null>(null);
  const inspectorToggleRef = useRef<HTMLSpanElement | null>(null);
  const sidebarAsideRef = useRef<HTMLElement | null>(null);
  const inspectorAsideRef = useRef<HTMLElement | null>(null);
  const lastFocusedPaneRef = useRef<"sidebar" | "inspector" | null>(null);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (target && sidebarAsideRef.current?.contains(target)) {
        lastFocusedPaneRef.current = "sidebar";
      } else if (target && inspectorAsideRef.current?.contains(target)) {
        lastFocusedPaneRef.current = "inspector";
      } else {
        lastFocusedPaneRef.current = null;
      }
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }, []);

  useEffect(() => {
    if (
      !showSidebar &&
      (sidebarAsideRef.current?.contains(document.activeElement) ||
        (document.activeElement === document.body &&
          lastFocusedPaneRef.current === "sidebar"))
    ) {
      lastFocusedPaneRef.current = null;
      const toggleBtn = sidebarToggleRef.current?.querySelector("button");
      if (toggleBtn && !toggleBtn.disabled) {
        suppressNextFocusTooltip();
        toggleBtn.focus();
      } else {
        suppressNextFocusTooltip();
        inspectorAsideRef.current
          ?.querySelector<HTMLElement>("button:not([disabled]), [tabindex='0']")
          ?.focus();
      }
    }
  }, [showSidebar]);

  useEffect(() => {
    if (
      !showInspector &&
      (inspectorAsideRef.current?.contains(document.activeElement) ||
        (document.activeElement === document.body &&
          lastFocusedPaneRef.current === "inspector"))
    ) {
      lastFocusedPaneRef.current = null;
      suppressNextFocusTooltip();
      inspectorToggleRef.current?.querySelector("button")?.focus();
    }
  }, [showInspector]);

  const availWidth = Math.max(640, viewportWidth - RAIL_WIDTH_PX);
  const liveMaxSidebar = Math.min(
    340,
    Math.max(188, availWidth - (showInspector ? inspectorWidth : 0) - 340),
  );
  const liveMaxInspector = Math.min(
    760,
    Math.max(280, availWidth - (showSidebar ? sidebarWidth : 0) - 340),
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-surface)]">
      {/* Unified 44px Top Header */}
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar)] px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {hasSidebar && onToggleSidebar && (
            <span ref={sidebarToggleRef} className="inline-flex shrink-0">
              <IconButton
                data-sidebar-toggle="true"
                label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
                shortcut={effectiveExpanded ? undefined : "["}
                active={sidebarOpen && !effectiveExpanded}
                disabled={effectiveExpanded}
                onClick={onToggleSidebar}
              >
                <PanelLeft className="h-4 w-4" strokeWidth={1.5} />
              </IconButton>
            </span>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {headerLeft}
          </div>
        </div>

        <div className="flex min-w-0 shrink-0 items-center gap-1">
          {headerRight}
          {hasInspector && onToggleInspector && (
            <>
              {headerRight && (
                <span className="mx-1 h-4 w-px bg-[var(--border-hairline)]" />
              )}
              <span ref={inspectorToggleRef} className="inline-flex shrink-0">
                <IconButton
                  data-inspector-toggle="true"
                  label={
                    inspectorToggleLabel ??
                    (inspectorOpen ? "Collapse inspector" : "Expand inspector")
                  }
                  shortcut={inspectorToggleShortcut ?? "]"}
                  active={inspectorOpen}
                  onClick={onToggleInspector}
                >
                  <PanelRight className="h-4 w-4" strokeWidth={1.5} />
                </IconButton>
              </span>
            </>
          )}
        </div>
      </header>

      {/* Optional quiet top banners (alerts / updates / approvals) */}
      {banners}

      {/* 3-Pane Workspace Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Resizable Collapsible Left Context Sidebar */}
        {hasSidebar && (
          <aside
            id={sidebarPaneId}
            ref={sidebarAsideRef}
            aria-label="Module sidebar"
            aria-hidden={!showSidebar}
            style={{ width: showSidebar ? `${sidebarWidth}px` : "0px" }}
            className={`relative flex shrink-0 flex-col overflow-hidden bg-[var(--bg-sidebar)] ${
              isDragging
                ? ""
                : "transition-[width,opacity] duration-150 ease-out"
            } ${
              showSidebar
                ? "visible border-r border-[var(--border-hairline)] opacity-100"
                : "invisible border-r-0 opacity-0 pointer-events-none"
            }`}
          >
            <div
              style={{ width: `${sidebarWidth}px` }}
              className="flex h-full flex-col overflow-hidden"
            >
              {sidebar}
            </div>
            {showSidebar && (
              <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-controls={sidebarPaneId}
                aria-label="Resize sidebar (Arrow keys, Shift+Arrow for larger step, Home or 0 to reset, End to maximize, Enter to collapse, double-click to reset)"
                aria-valuemin={188}
                aria-valuemax={liveMaxSidebar}
                aria-valuenow={sidebarWidth}
                aria-valuetext={`${sidebarWidth} pixels`}
                onDoubleClick={() => {
                  setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
                  writeModulePaneWidth(
                    moduleId,
                    "sidebar",
                    DEFAULT_SIDEBAR_WIDTH,
                  );
                }}
                onKeyDown={(e) => {
                  const avail = Math.max(640, window.innerWidth - RAIL_WIDTH_PX);
                  const maxSidebar = Math.min(
                    340,
                    Math.max(188, avail - (showInspector ? inspectorWidth : 0) - 340),
                  );
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    e.stopPropagation();
                    const step = e.shiftKey ? 48 : 16;
                    const delta = e.key === "ArrowRight" ? step : -step;
                    const next = Math.max(
                      188,
                      Math.min(maxSidebar, sidebarWidth + delta),
                    );
                    setSidebarWidth(next);
                    writeModulePaneWidth(moduleId, "sidebar", next);
                  } else if (e.key === "Home" || e.key === "0") {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = Math.min(maxSidebar, DEFAULT_SIDEBAR_WIDTH);
                    setSidebarWidth(next);
                    writeModulePaneWidth(moduleId, "sidebar", next);
                  } else if (e.key === "End") {
                    e.preventDefault();
                    e.stopPropagation();
                    setSidebarWidth(maxSidebar);
                    writeModulePaneWidth(moduleId, "sidebar", maxSidebar);
                  } else if (e.key === "Enter" && onToggleSidebar) {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleSidebar();
                    requestAnimationFrame(() => {
                      suppressNextFocusTooltip();
                      sidebarToggleRef.current?.querySelector("button")?.focus();
                    });
                  }
                }}
                onMouseDown={() => {
                  dragModeRef.current = "sidebar";
                  setIsDragging(true);
                  document.body.style.cursor = "col-resize";
                  document.body.style.userSelect = "none";
                }}
                className="group/sep absolute top-0 right-0 bottom-0 z-20 flex w-1.5 cursor-col-resize items-center justify-center transition-colors hover:bg-[var(--border-strong)]/25 focus-visible:bg-[var(--border-strong)]/25"
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-[2px] rounded-full bg-[var(--border-strong)] opacity-0 transition-all group-hover/sep:h-10 group-hover/sep:bg-[var(--accent)] group-hover/sep:opacity-100 group-focus-visible/sep:h-10 group-focus-visible/sep:bg-[var(--accent)] group-focus-visible/sep:opacity-100"
                />
              </div>
            )}
          </aside>
        )}

        {/* Main Fluid Canvas (kept mounted when inspector expands so scroll & selection persist) */}
        <main
          id="fr-main-content"
          tabIndex={-1}
          aria-hidden={effectiveExpanded || undefined}
          className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-surface)] focus:outline-none ${
            effectiveExpanded ? "hidden" : "flex"
          }`}
        >
          {canvasMode === "document" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <div className="mx-auto w-full max-w-4xl space-y-5">
                {children}
              </div>
            </div>
          ) : (
            children
          )}
        </main>

        {/* Resizable Collapsible Right Inspector / Preview Drawer */}
        {hasInspector && (
          <aside
            id={inspectorPaneId}
            ref={inspectorAsideRef}
            aria-label={inspectorLabel}
            aria-hidden={!showInspector}
            style={
              showInspector
                ? effectiveExpanded
                  ? { width: "100%" }
                  : { width: `${inspectorWidth}px` }
                : { width: "0px" }
            }
            className={`relative flex shrink-0 flex-col overflow-hidden bg-[var(--bg-sidebar)] ${
              isDragging || effectiveExpanded
                ? ""
                : "transition-[width,opacity] duration-150 ease-out"
            } ${effectiveExpanded ? "min-w-0 flex-1" : ""} ${
              showInspector
                ? effectiveExpanded
                  ? "visible opacity-100"
                  : "visible border-l border-[var(--border-hairline)] opacity-100"
                : "invisible border-l-0 opacity-0 pointer-events-none"
            }`}
          >
            {showInspector && !effectiveExpanded && (
              <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-controls={inspectorPaneId}
                aria-label="Resize inspector panel (Arrow keys, Shift+Arrow for larger step, Home or 0 to reset, End to maximize, Enter to collapse, double-click to reset)"
                aria-valuemin={280}
                aria-valuemax={liveMaxInspector}
                aria-valuenow={inspectorWidth}
                aria-valuetext={`${inspectorWidth} pixels`}
                onDoubleClick={() => {
                  setInspectorWidth(inspectorDefaultWidth);
                  writeModulePaneWidth(
                    moduleId,
                    "inspector",
                    inspectorDefaultWidth,
                  );
                }}
                onKeyDown={(e) => {
                  const avail = Math.max(640, window.innerWidth - RAIL_WIDTH_PX);
                  const maxInspector = Math.min(
                    760,
                    Math.max(280, avail - (showSidebar ? sidebarWidth : 0) - 340),
                  );
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    e.stopPropagation();
                    const step = e.shiftKey ? 48 : 16;
                    const delta = e.key === "ArrowLeft" ? step : -step;
                    const next = Math.max(
                      280,
                      Math.min(maxInspector, inspectorWidth + delta),
                    );
                    setInspectorWidth(next);
                    writeModulePaneWidth(moduleId, "inspector", next);
                  } else if (e.key === "Home" || e.key === "0") {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = Math.min(maxInspector, inspectorDefaultWidth);
                    setInspectorWidth(next);
                    writeModulePaneWidth(moduleId, "inspector", next);
                  } else if (e.key === "End") {
                    e.preventDefault();
                    e.stopPropagation();
                    setInspectorWidth(maxInspector);
                    writeModulePaneWidth(moduleId, "inspector", maxInspector);
                  } else if (e.key === "Enter" && onToggleInspector) {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleInspector();
                    requestAnimationFrame(() => {
                      suppressNextFocusTooltip();
                      inspectorToggleRef.current?.querySelector("button")?.focus();
                    });
                  }
                }}
                onMouseDown={() => {
                  dragModeRef.current = "inspector";
                  setIsDragging(true);
                  document.body.style.cursor = "col-resize";
                  document.body.style.userSelect = "none";
                }}
                className="group/sep absolute top-0 bottom-0 left-0 z-20 flex w-1.5 cursor-col-resize items-center justify-center transition-colors hover:bg-[var(--border-strong)]/25 focus-visible:bg-[var(--border-strong)]/25"
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-[2px] rounded-full bg-[var(--border-strong)] opacity-0 transition-all group-hover/sep:h-10 group-hover/sep:bg-[var(--accent)] group-hover/sep:opacity-100 group-focus-visible/sep:h-10 group-focus-visible/sep:bg-[var(--accent)] group-focus-visible/sep:opacity-100"
                />
              </div>
            )}
            <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
              {inspector}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

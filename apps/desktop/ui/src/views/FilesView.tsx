import {
  Box,
  Cloud,
  FileCode2,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  Settings,
} from "lucide-react";
import type { NextcloudConnectionStatus } from "../bindings/tauri";

interface FilesViewProps {
  connectionStatus: NextcloudConnectionStatus;
  onOpenSettings: () => void;
}

const SUPPORTED_FORMATS = [
  {
    icon: FileText,
    label: "Markdown Notes",
    detail: "WYSIWYG editor + raw mode with conflict protection (.md)",
  },
  {
    icon: ImageIcon,
    label: "Images & PDFs",
    detail: "Zoom, pan, and document search (.png, .jpg, .webp, .pdf)",
  },
  {
    icon: Film,
    label: "Video Streaming",
    detail: "Instant playback via local Range proxy (.mp4, .mov, .webm)",
  },
  {
    icon: Layers,
    label: "Vector Files",
    detail: "Sanitized SVG, Illustrator AI, DXF CAD & EPS",
  },
  {
    icon: Box,
    label: "SolidWorks CAD",
    detail: "Client-side thumbnails & metadata (.sldprt, .sldasm, .slddrw)",
  },
  {
    icon: FileCode2,
    label: "Native Open",
    detail: "Launch any file directly in its desktop app with one click",
  },
];

export function FilesView({
  connectionStatus,
  onOpenSettings,
}: FilesViewProps) {
  const configuredServer =
    connectionStatus.state === "notConfigured"
      ? null
      : connectionStatus.serverUrl;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
              <Cloud className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Connect your Nextcloud workspace
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                {configuredServer ? (
                  <>
                    Ready for{" "}
                    <span className="font-medium text-slate-900 dark:text-slate-200">
                      {configuredServer}
                    </span>
                    . One-click browser sign-in (Login Flow v2) arrives in Phase 1.
                  </>
                ) : (
                  "Enter your team's Nextcloud server address in Settings to get started."
                )}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-blue-700"
          >
            <Settings className="h-4 w-4" />
            {configuredServer ? "Change Server" : "Configure Server"}
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
          Built for your team&apos;s files
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SUPPORTED_FORMATS.map(({ icon: Icon, label, detail }) => (
            <div
              key={label}
              className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-center gap-2.5">
                <Icon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {label}
                </p>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {detail}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

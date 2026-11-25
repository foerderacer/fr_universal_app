import { Sparkles } from "lucide-react";
import type { ModuleDescriptor } from "../bindings/tauri";

interface ModuleComingSoonViewProps {
  module: ModuleDescriptor;
}

export function ModuleComingSoonView({ module }: ModuleComingSoonViewProps) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <Sparkles className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
          {module.name} Module
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600 dark:text-slate-400">
          {module.description}
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {module.capabilities.map((cap) => (
            <span
              key={cap}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {cap}
            </span>
          ))}
        </div>

        <p className="mt-6 text-xs text-slate-400 dark:text-slate-500">
          Registered in Rust ModuleRegistry (v{module.version}) · Scheduled for Phase 3
        </p>
      </div>
    </div>
  );
}

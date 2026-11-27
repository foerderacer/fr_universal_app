import { Blocks } from "lucide-react";
import type { ModuleDescriptor } from "../bindings/tauri";
import { WorkspaceLayout } from "../components/shell/WorkspaceLayout";

interface ModuleComingSoonViewProps {
  module: ModuleDescriptor;
  banners?: React.ReactNode;
}

export function ModuleComingSoonView({
  module,
  banners,
}: ModuleComingSoonViewProps) {
  return (
    <WorkspaceLayout
      moduleId={module.id}
      headerLeft={
        <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
          {module.name}
        </h1>
      }
      inspectorOpen={false}
      banners={banners}
    >
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-md border border-[var(--border-hairline)] bg-[var(--bg-sidebar)] p-6 text-center">
          <Blocks
            className="mx-auto h-7 w-7 text-[var(--text-muted)]"
            strokeWidth={1.5}
          />
          <h2 className="mt-3 text-sm font-medium text-[var(--text-primary)]">
            {module.name}
          </h2>
          <p className="mt-1.5 text-xs text-[var(--text-secondary)]">
            {module.description}
          </p>
          <p className="mono-num mt-4 text-[11px] text-[var(--text-muted)]">
            v{module.version}
          </p>
        </div>
      </div>
    </WorkspaceLayout>
  );
}

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { isElectron } from "../env";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <p className="aris-section-label mb-3">ARIS workspace</p>
              <EmptyTitle className="aris-title text-foreground text-xl font-semibold tracking-tight">
                Pick a thread to continue
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Select an existing thread or create a new one to get started. Open ARIS command
                center for devices, projects, and voice.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

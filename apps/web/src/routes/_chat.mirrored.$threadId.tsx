import { createFileRoute } from "@tanstack/react-router";

import { MirroredThreadView } from "../components/MirroredThreadView";
import { SidebarInset } from "../components/ui/sidebar";

function MirroredThreadRouteView() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <MirroredThreadView />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/mirrored/$threadId")({
  component: MirroredThreadRouteView,
});

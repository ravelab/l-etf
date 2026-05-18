import type { ReactNode } from "react";
import { maybeRunAutoRefresh } from "@/lib/data/auto-refresh";

export const dynamic = "force-dynamic";

export default function ToolsLayout({ children }: { children: ReactNode }) {
  maybeRunAutoRefresh();
  return <>{children}</>;
}

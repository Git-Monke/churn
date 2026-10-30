import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface AppHeaderProps {
  checkedAt?: string;
  refreshing: boolean;
  onRefresh: () => void;
}

export function AppHeader({ checkedAt, refreshing, onRefresh }: AppHeaderProps) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Churn</h1>
        <p className="text-sm text-muted-foreground">
          Your Jellyfin library and media automation, in one place.{" "}
          {checkedAt ? (
            <span>Last checked {formatTime(checkedAt)}.</span>
          ) : (
            <span>Checking services…</span>
          )}
        </p>
      </div>
      <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
        <RefreshCwIcon data-icon="inline-start" className={refreshing ? "animate-spin" : undefined} />
        Refresh
      </Button>
    </header>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

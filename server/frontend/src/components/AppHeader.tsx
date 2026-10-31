import { RefreshCwIcon } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import type { AppRoute } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

interface AppHeaderProps {
  route: AppRoute;
  checkedAt?: string;
  refreshing: boolean;
  onRefresh: () => void;
}

const NAV_ITEMS = [
  { page: "services", label: "Services", href: "#/services" },
  { page: "library", label: "Library", href: "#/library" },
  { page: "search", label: "Search", href: "#/search" },
] as const;

export function AppHeader({ route, checkedAt, refreshing, onRefresh }: AppHeaderProps) {
  const activePage = route.page === "show" ? "library" : route.page;

  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
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
      </div>

      <nav aria-label="Primary" className="flex flex-wrap items-center gap-1 border-b pb-2">
        {NAV_ITEMS.map((item) => {
          const active = activePage === item.page;
          return (
            <a
              key={item.page}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" }),
                "px-3",
              )}
            >
              {item.label}
            </a>
          );
        })}
      </nav>
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

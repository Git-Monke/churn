import { ChevronDownIcon, LogOutIcon, MonitorCogIcon, UsersIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/features/auth/AuthProvider";
import type { AppRoute } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

interface AppHeaderProps {
  route: AppRoute;
}

const NAV_ITEMS = [
  { page: "library", label: "Library", href: "#/library" },
  { page: "search", label: "Find something new", href: "#/search" },
] as const;

export function AppHeader({ route }: AppHeaderProps) {
  const { session, logout, isPending } = useAuth();
  const activePage = route.page === "show" || route.page === "play" ? "library" : route.page;
  const user = session?.user;
  const isAdmin = user?.isAdmin === true;

  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-content flex-wrap items-center gap-x-6 px-4 sm:px-6 lg:px-10">
        <a
          href="#/library"
          className="flex h-17 items-center font-heading text-2xl font-semibold tracking-tight lowercase"
        >
          churn
        </a>

        <nav
          aria-label="Primary"
          className="flex flex-wrap items-stretch gap-6 self-stretch"
        >
          {NAV_ITEMS.map((item) => {
            const active = activePage === item.page;
            return (
              <a
                key={item.page}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-17 items-center border-b-2 px-1 text-sm font-medium transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        {user ? (
          <div className="ml-auto flex items-center gap-2 py-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-auto gap-2 py-1 pr-1.5 pl-1">
                  <Avatar size="sm">
                    <AvatarFallback>{initial(user.name)}</AvatarFallback>
                  </Avatar>
                  <span className="max-w-40 truncate">{user.name}</span>
                  <ChevronDownIcon className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="truncate">{user.name}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={isPending}
                    onSelect={() => void logout()}
                  >
                    <LogOutIcon />
                    Switch person
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {isAdmin ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem asChild>
                        <a href="#/services">
                          <MonitorCogIcon />
                          Services
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <a href="#/people">
                          <UsersIcon />
                          People
                        </a>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

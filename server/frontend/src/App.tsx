import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { fetchStatus } from "@/api/client";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { AppHeader } from "@/components/AppHeader";
import { AuthProvider, useAuth } from "@/features/auth/AuthProvider";
import { useHashRoute } from "@/hooks/use-hash-route";
import { LibraryPage } from "@/pages/LibraryPage";
import { LoginPage } from "@/pages/LoginPage";
import { PlayPage } from "@/pages/PlayPage";
import { SearchPage } from "@/pages/SearchPage";
import { ServicesPage } from "@/pages/ServicesPage";
import { ShowPage } from "@/pages/ShowPage";

export default function App() {
  return (
    <>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
      <Toaster theme="dark" richColors />
    </>
  );
}

function AppShell() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return <AppLoading />;
  }
  if (!session?.authenticated || !session.user) {
    return <LoginPage />;
  }
  return <Dashboard />;
}

function Dashboard() {
  const route = useHashRoute();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: 30_000,
  });

  const jellyfinUrl = useMemo(
    () => statusQuery.data?.services.find((service) => service.id === "jellyfin")?.url,
    [statusQuery.data],
  );

  async function refresh() {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ type: "active" });
      const failed = queryClient
        .getQueryCache()
        .findAll({ type: "active" })
        .some((query) => query.state.status === "error");
      if (failed) {
        toast.error("Some data could not be refreshed");
      } else {
        toast.success("Dashboard refreshed");
      }
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <AppHeader
        route={route}
        checkedAt={statusQuery.data?.checkedAt}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
      />

      {route.page === "services" ? (
        <ServicesPage
          status={statusQuery.data}
          loading={statusQuery.isLoading}
          error={statusQuery.error}
        />
      ) : null}
      {route.page === "library" ? <LibraryPage jellyfinUrl={jellyfinUrl} /> : null}
      {route.page === "show" ? (
        <ShowPage key={`${route.source}:${route.id}`} source={route.source} id={route.id} />
      ) : null}
      {route.page === "search" ? <SearchPage /> : null}
      {route.page === "play" ? <PlayPage key={route.id} id={route.id} /> : null}
    </div>
  );
}

function AppLoading() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchStatus } from "@/api/client";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { AppHeader } from "@/components/AppHeader";
import { AuthProvider, useAuth } from "@/features/auth/AuthProvider";
import { useHashRoute } from "@/hooks/use-hash-route";
import { LibraryPage } from "@/pages/LibraryPage";
import { LoginPage } from "@/pages/LoginPage";
import { MoviePage } from "@/pages/MoviePage";
import { PeoplePage } from "@/pages/PeoplePage";
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
  const { session } = useAuth();
  const isAdmin = session?.user?.isAdmin === true;

  useEffect(() => {
    if (route.page === "people" && !isAdmin) {
      window.location.hash = "#/services";
    }
  }, [route.page, isAdmin]);
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: 30_000,
  });

  const jellyfinUrl = useMemo(
    () => statusQuery.data?.services.find((service) => service.id === "jellyfin")?.url,
    [statusQuery.data],
  );

  return (
    <div className="flex min-h-dvh w-full flex-col">
      <AppHeader route={route} />
      <main className="mx-auto flex w-full max-w-content flex-1 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-10">
        {route.page === "services" ? (
          <ServicesPage
            status={statusQuery.data}
            loading={statusQuery.isLoading}
            error={statusQuery.error}
          />
        ) : null}
        {route.page === "library" ? <LibraryPage jellyfinUrl={jellyfinUrl} /> : null}
        {route.page === "show" ? (
          <ShowPage
            key={`${route.source}:${route.id}`}
            source={route.source}
            id={route.id}
            season={route.season}
          />
        ) : null}
        {route.page === "movie" ? (
          <MoviePage key={`${route.source}:${route.id}`} source={route.source} id={route.id} />
        ) : null}
        {route.page === "search" ? <SearchPage /> : null}
        {route.page === "people" && isAdmin ? <PeoplePage /> : null}
        {route.page === "play" ? (
          <PlayPage key={route.id} id={route.id} from={route.from} />
        ) : null}
      </main>
    </div>
  );
}

function AppLoading() {
  return (
    <div className="flex min-h-dvh w-full flex-col">
      <div className="flex h-17 items-center border-b">
        <div className="mx-auto flex w-full max-w-content items-center gap-8 px-4 sm:px-6 lg:px-10">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-8 w-32" />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-content flex-col gap-8 px-4 py-8 sm:px-6 lg:px-10">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}

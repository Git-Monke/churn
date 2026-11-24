import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchStatus } from "@/api/client";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { AppHeader } from "@/components/AppHeader";
import { AuthProvider, useAuth } from "@/features/auth/AuthProvider";
import { PasskeySettings } from "@/features/auth/PasskeySettings";
import { useLibraryPosterNavigation } from "@/features/library/use-library-poster-navigation";
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
  const [showPasskeys, setShowPasskeys] = useState(false);
  const authenticated = session?.authenticated === true && !!session.user;

  useEffect(() => {
    if (!authenticated) setShowPasskeys(false);
  }, [authenticated]);

  if (isLoading) {
    return <AppLoading />;
  }
  if (!authenticated) {
    return <LoginPage />;
  }
  return (
    <>
      <Dashboard onManagePasskeys={() => setShowPasskeys(true)} />
      {showPasskeys ? <PasskeySettings onClose={() => setShowPasskeys(false)} /> : null}
    </>
  );
}

function Dashboard({ onManagePasskeys }: { onManagePasskeys: () => void }) {
  const { route, poster, keepLibrary, main, onLibraryClick } = useLibraryPosterNavigation();
  const { session, signedIn } = useAuth();
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
    <div className={`flex min-h-dvh w-full flex-col${signedIn ? " motion-signin-arrive" : ""}`}>
      <AppHeader route={route} onManagePasskeys={onManagePasskeys} />
      <main ref={main} tabIndex={-1} data-title-from-library={poster ? "" : undefined} className="mx-auto flex w-full max-w-content flex-1 flex-col gap-8 px-4 py-6 sm:px-6 lg:px-10">
        {route.page === "services" ? (
          <ServicesPage
            status={statusQuery.data}
            loading={statusQuery.isLoading}
            error={statusQuery.error}
          />
        ) : null}
        {keepLibrary ? (
          <div hidden={route.page !== "library"} onClick={onLibraryClick}>
            <LibraryPage jellyfinUrl={jellyfinUrl} />
          </div>
        ) : null}
        {route.page === "show" ? (
          <ShowPage
            key={`${route.source}:${route.id}`}
            source={route.source}
            id={route.id}
            season={route.season}
            pendingPosterUrl={poster?.imageUrl}
          />
        ) : null}
        {route.page === "movie" ? (
          <MoviePage key={`${route.source}:${route.id}`} source={route.source} id={route.id} pendingPosterUrl={poster?.imageUrl} />
        ) : null}
        {route.page === "search" ? <SearchPage /> : null}
        {route.page === "people" && isAdmin ? <PeoplePage /> : null}
        {route.page === "play" ? (
          <PlayPage
            key={route.id}
            id={route.id}
            from={route.from}
            restart={route.restart}
          />
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
      <div className="mx-auto flex w-full max-w-content flex-col gap-8 px-4 py-6 sm:px-6 lg:px-10">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}

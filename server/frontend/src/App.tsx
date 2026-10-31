import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { fetchLibrary, fetchStatus } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Toaster } from "@/components/ui/sonner";
import { AppHeader } from "@/components/AppHeader";
import { LibrarySection } from "@/features/library/LibrarySection";
import { SearchSection } from "@/features/search/SearchSection";
import { ServiceStatusGrid } from "@/features/status/ServiceStatusGrid";

export default function App() {
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: 30_000,
  });
  const libraryQuery = useQuery({
    queryKey: ["library"],
    queryFn: fetchLibrary,
    refetchInterval: 60_000,
  });

  const refreshing = statusQuery.isFetching || libraryQuery.isFetching;
  const jellyfinUrl = useMemo(
    () => statusQuery.data?.services.find((service) => service.id === "jellyfin")?.url,
    [statusQuery.data],
  );

  async function refresh() {
    const results = await Promise.allSettled([statusQuery.refetch(), libraryQuery.refetch()]);
    const failed = results.some((result) => result.status === "rejected");
    if (failed) {
      toast.error("Some data could not be refreshed");
    } else {
      toast.success("Dashboard refreshed");
    }
  }

  return (
    <>
      <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <AppHeader
          checkedAt={statusQuery.data?.checkedAt}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
        />

        {statusQuery.error && statusQuery.data ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Service status is stale</AlertTitle>
            <AlertDescription>{statusQuery.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <ServiceStatusGrid
          services={statusQuery.data?.services}
          loading={statusQuery.isLoading}
          error={statusQuery.error}
        />

        <SearchSection />

        <LibrarySection
          library={libraryQuery.data}
          loading={libraryQuery.isLoading}
          error={libraryQuery.error}
          jellyfinUrl={jellyfinUrl}
        />
      </div>
      <Toaster theme="dark" richColors />
    </>
  );
}

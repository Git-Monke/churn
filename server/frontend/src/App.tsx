import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { fetchStatus } from "@/api/client";
import { Toaster } from "@/components/ui/sonner";
import { AppHeader } from "@/components/AppHeader";
import { useHashRoute } from "@/hooks/use-hash-route";
import { LibraryPage } from "@/pages/LibraryPage";
import { SearchPage } from "@/pages/SearchPage";
import { ServicesPage } from "@/pages/ServicesPage";
import { ShowPage } from "@/pages/ShowPage";

export default function App() {
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
    <>
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
      </div>
      <Toaster theme="dark" richColors />
    </>
  );
}

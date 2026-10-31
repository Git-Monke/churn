import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { toast } from "sonner";

import {
  createRequest,
  fetchRequestOptions,
  fetchSearch,
} from "@/api/client";
import type {
  CreateRequestInput,
  SearchResponse,
  SearchResult,
  SearchServiceState,
} from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { RequestOptionsPopover } from "@/features/search/RequestOptionsPopover";
import {
  SearchResultGrid,
  SearchResultGridSkeleton,
} from "@/features/search/SearchResultGrid";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRequestDefaults } from "@/features/search/use-request-defaults";

export function SearchSection() {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 350);
  const term = debounced.trim();
  const searchEnabled = term.length >= 2;
  const queryClient = useQueryClient();

  const optionsQuery = useQuery({
    queryKey: ["request-options"],
    queryFn: fetchRequestOptions,
    staleTime: 5 * 60_000,
  });
  const { defaults, update } = useRequestDefaults(optionsQuery.data);

  const searchQuery = useQuery({
    queryKey: ["search", term],
    queryFn: () => fetchSearch(term),
    enabled: searchEnabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const requestMutation = useMutation({
    mutationFn: createRequest,
    onSuccess: (data, variables) => {
      const key = requestKey(variables);
      if (data.status === "added") {
        toast.success(`Requested ${formatTitle(data.title, data.year)}`);
      } else {
        toast.info(`${formatTitle(data.title, data.year)} is already requested`);
      }
      if (key) {
        queryClient.setQueriesData<SearchResponse>({ queryKey: ["search"] }, (current) =>
          current
            ? {
                ...current,
                results: current.results.map((result) =>
                  result.key === key ? { ...result, inLibrary: true } : result,
                ),
              }
            : current,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["search"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const requestingKey =
    requestMutation.isPending && requestMutation.variables
      ? requestKey(requestMutation.variables)
      : null;

  function handleRequest(result: SearchResult) {
    const service = result.kind === "movie" ? "radarr" : "sonarr";
    const serviceOptions = optionsQuery.data?.services[service];
    if (serviceOptions && serviceOptions.state !== "ok") {
      toast.error(`${service === "sonarr" ? "Sonarr" : "Radarr"} is not ready`, {
        description: serviceOptions.detail,
      });
      return;
    }

    const serviceDefaults = defaults[service];
    if (
      serviceDefaults.qualityProfileId === undefined ||
      !serviceDefaults.rootFolderPath
    ) {
      toast.error("Choose request options first", {
        description: "Open Request options and select a quality profile and root folder.",
      });
      return;
    }

    const input: CreateRequestInput = {
      kind: result.kind,
      options: {
        qualityProfileId: serviceDefaults.qualityProfileId,
        rootFolderPath: serviceDefaults.rootFolderPath,
        searchOnAdd: serviceDefaults.searchOnAdd,
        ...(result.kind === "series"
          ? { monitor: serviceDefaults.monitor ?? "all" }
          : {}),
      },
    };

    if (result.kind === "movie") {
      if (result.tmdbId === undefined) {
        toast.error("This movie cannot be requested (missing TMDB id)");
        return;
      }
      input.tmdbId = result.tmdbId;
    } else {
      if (result.tvdbId === undefined) {
        toast.error("This series cannot be requested (missing TVDB id)");
        return;
      }
      input.tvdbId = result.tvdbId;
    }

    requestMutation.mutate(input);
  }

  const searchData = searchQuery.data;
  const serviceNotices = searchData?.services.filter(
    (service) => service.state !== "ok" || service.detail,
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-xl font-semibold tracking-tight">Search</h2>
          <p className="text-sm text-muted-foreground">
            Find movies in Radarr and shows in Sonarr, then request a download.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row lg:items-center">
          <InputGroup className="w-full sm:w-80">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search movies and series…"
              aria-label="Search movies and series"
              autoComplete="off"
            />
            {searchQuery.isFetching ? (
              <InputGroupAddon align="inline-end">
                <Loader2Icon className="animate-spin" />
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <RequestOptionsPopover
            options={optionsQuery.data}
            loading={optionsQuery.isLoading}
            error={optionsQuery.error}
            defaults={defaults}
            onChange={update}
          />
        </div>
      </div>

      {serviceNotices?.map((service) => (
        <SearchServiceNotice key={service.id} service={service} />
      ))}

      {searchQuery.error && !searchQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Search failed</AlertTitle>
          <AlertDescription>{searchQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {!searchEnabled && !searchData ? <SearchPrompt /> : null}
      {searchEnabled && searchQuery.isLoading ? <SearchResultGridSkeleton /> : null}

      {searchEnabled && searchData && searchData.results.length > 0 ? (
        <SearchResultGrid
          results={searchData.results}
          onRequest={handleRequest}
          requestingKey={requestingKey}
          requestDisabled={optionsQuery.isLoading || requestMutation.isPending}
          seriesMonitor={defaults.sonarr.monitor}
        />
      ) : null}

      {searchEnabled &&
      searchData &&
      searchData.results.length === 0 &&
      searchData.services.some((service) => service.state === "ok") ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>No results for “{searchData.query}”</EmptyTitle>
            <EmptyDescription>
              Try a different title or check that the title exists in Sonarr or Radarr.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </section>
  );
}

function SearchServiceNotice({ service }: { service: SearchServiceState }) {
  const name = service.id === "sonarr" ? "Sonarr" : "Radarr";
  return (
    <Alert variant={service.state === "unconfigured" ? "default" : "destructive"}>
      <CircleAlertIcon />
      <AlertTitle>
        {service.state === "ok" ? `${name} results are limited` : `${name} is not ready`}
      </AlertTitle>
      <AlertDescription>
        {service.detail ?? `Check that ${name} is running and its API key is configured.`}
      </AlertDescription>
    </Alert>
  );
}

function SearchPrompt() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchIcon />
        </EmptyMedia>
        <EmptyTitle>Find something to watch</EmptyTitle>
        <EmptyDescription>
          Search for a movie or series. Results come from Radarr and Sonarr and can be
          requested in one click.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function requestKey(input: CreateRequestInput): string | null {
  if (input.kind === "movie") {
    return input.tmdbId === undefined ? null : `movie:${input.tmdbId}`;
  }
  return input.tvdbId === undefined ? null : `series:${input.tvdbId}`;
}

function formatTitle(title: string, year?: number): string {
  return year ? `${title} (${year})` : title;
}

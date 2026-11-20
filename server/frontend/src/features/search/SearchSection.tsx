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
import { Button } from "@/components/ui/button";
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

import { SearchResults, SearchResultsSkeleton } from "@/features/search/SearchResults";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRequestDefaults } from "@/features/search/use-request-defaults";

interface RequestMutationVariables {
  input: CreateRequestInput;
  result: SearchResult;
}

export function SearchSection() {
  const [query, setQuery] = useState("");
  const [showNiche, setShowNiche] = useState(false);
  const debounced = useDebouncedValue(query, 350);
  const term = debounced.trim();
  const searchEnabled = term.length >= 2;
  const queryClient = useQueryClient();
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [requestLinks, setRequestLinks] = useState(() =>
    queryClient.getQueryData<Record<string, string>>(["search-request-links"]) ?? {},
  );

  const optionsQuery = useQuery({
    queryKey: ["request-options"],
    queryFn: fetchRequestOptions,
    staleTime: 5 * 60_000,
  });
  const defaults = useRequestDefaults(optionsQuery.data);

  const searchQuery = useQuery({
    queryKey: ["search", term],
    queryFn: () => fetchSearch(term),
    enabled: searchEnabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const requestMutation = useMutation({
    mutationFn: ({ input }: RequestMutationVariables) => createRequest(input),
    onSuccess: (data, variables) => {
      const key = requestKey(variables.input);
      const href = data.id === undefined ? undefined : data.service === "sonarr"
        ? `#/library/show/sonarr/${data.id}`
        : `#/library/movie/radarr/${data.id}`;
      if (key && href) {
        const links = queryClient.setQueryData<Record<string, string>>(
          ["search-request-links"],
          (previous) => ({ ...previous, [key]: href }),
        );
        if (links) setRequestLinks(links);
      }
      const viewAction = href
        ? { label: "Pick a version", onClick: () => { window.location.hash = href; } }
        : undefined;
      if (data.status === "added") {
        toast.success(`Requested ${formatTitle(data.title, data.year)}`, {
          description:
            "Added to the library. Searching for releases in the background.",
          action: viewAction,
          duration: 12_000,
        });
      } else {
        toast.info(`${formatTitle(data.title, data.year)} is already requested`, {
          action: viewAction,
          duration: 12_000,
        });
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
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
      void queryClient.invalidateQueries({ queryKey: ["requested-library"] });
    },
    onError: (error, { result }) => reportRequestError(result.key, error.message),
  });

  const requestingKey =
    requestMutation.isPending && requestMutation.variables
      ? requestKey(requestMutation.variables.input)
      : null;

  function reportRequestError(key: string, message: string) {
    setRequestErrors((errors) => ({ ...errors, [key]: message }));
  }

  function handleRequest(result: SearchResult) {
    if (requestMutation.isPending) return;
    const service = result.kind === "movie" ? "radarr" : "sonarr";
    const serviceOptions = optionsQuery.data?.services[service];
    if (serviceOptions && serviceOptions.state !== "ok") {
      reportRequestError(result.key, serviceOptions.detail ?? `${service === "sonarr" ? "Sonarr" : "Radarr"} is not ready.`);
      return;
    }

    const serviceDefaults = defaults[service];
    if (
      serviceDefaults.qualityProfileId === undefined ||
      !serviceDefaults.rootFolderPath
    ) {
      reportRequestError(result.key, "Choose a quality profile and root folder in Request options, then retry.");
      return;
    }

    const input: CreateRequestInput = {
      kind: result.kind,
      options: {
        qualityProfileId: serviceDefaults.qualityProfileId,
        rootFolderPath: serviceDefaults.rootFolderPath,
      },
    };

    if (result.kind === "movie") {
      if (result.tmdbId === undefined) {
        reportRequestError(result.key, "This movie cannot be requested because it has no TMDB ID.");
        return;
      }
      input.tmdbId = result.tmdbId;
    } else {
      if (result.tvdbId === undefined) {
        reportRequestError(result.key, "This series cannot be requested because it has no TVDB ID.");
        return;
      }
      input.tvdbId = result.tvdbId;
    }

    setRequestErrors((errors) => {
      const next = { ...errors };
      delete next[result.key];
      return next;
    });
    requestMutation.mutate({ input, result });
  }

  const searchData = searchQuery.data;
  const results = searchData?.results ?? [];
  const serviceNotices = searchData?.services.filter(
    (service) => service.state !== "ok" || service.detail,
  );

  return (
    <section className="flex flex-1 flex-col gap-6">
      <h1 className="sr-only">Search</h1>
      <InputGroup className="h-17 w-full rounded-none border-x-0 border-t-0 border-b border-border bg-transparent shadow-none dark:bg-transparent has-[[data-slot=input-group-control]:focus-visible]:border-primary has-[[data-slot=input-group-control]:focus-visible]:ring-0">
        <InputGroupAddon className="pl-0">
          <SearchIcon className="size-5" />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type your search here…"
          aria-label="Search movies and series"
          autoComplete="off"
          className="h-full pl-3! text-lg caret-primary placeholder:text-muted-foreground md:text-lg"
        />
        {searchQuery.isFetching ? (
          <InputGroupAddon align="inline-end" className="pr-0">
            <Loader2Icon className="animate-spin" />
          </InputGroupAddon>
        ) : null}
      </InputGroup>

      {serviceNotices?.map((service) => (
        <SearchServiceNotice key={service.id} service={service} />
      ))}

      {searchQuery.error && !searchQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Search failed</AlertTitle>
          <AlertDescription>{searchQuery.error.message}</AlertDescription>
          <Button variant="outline" size="sm" className="mt-2 w-fit" onClick={() => void searchQuery.refetch()}>
            Retry search
          </Button>
        </Alert>
      ) : null}

      {!searchEnabled ? (
        <div className="flex min-h-90 flex-1 items-center justify-center dashed-frame px-6 py-12">
          <p className="text-center text-sm text-muted-foreground">
            Results will appear as you begin typing…
          </p>
        </div>
      ) : null}

      {searchEnabled && searchQuery.isLoading ? <SearchResultsSkeleton /> : null}

      {searchEnabled && searchData && results.length > 0 ? (
        <SearchResults
          query={searchData.query}
          results={results}
          showNiche={showNiche}
          onShowNicheChange={setShowNiche}
          pending={searchQuery.isPlaceholderData}
          requestLinks={requestLinks}
          requestErrors={requestErrors}
          onRequest={handleRequest}
          requestingKey={requestingKey}
          requestDisabled={optionsQuery.isLoading || requestMutation.isPending}
        />
      ) : null}

      {searchEnabled &&
      searchData &&
      results.length === 0 &&
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

function requestKey(input: CreateRequestInput): string | null {
  if (input.kind === "movie") {
    return input.tmdbId === undefined ? null : `movie:${input.tmdbId}`;
  }
  return input.tvdbId === undefined ? null : `series:${input.tvdbId}`;
}

function formatTitle(title: string, year?: number): string {
  return year ? `${title} (${year})` : title;
}

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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RequestOptionsPopover } from "@/features/search/RequestOptionsPopover";
import {
  SearchResultGrid,
  SearchResultGridSkeleton,
} from "@/features/search/SearchResultGrid";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRequestDefaults } from "@/features/search/use-request-defaults";

interface RequestMutationVariables {
  input: CreateRequestInput;
  result: SearchResult;
}

/** Titles below this vote count are treated as noise until asked for. */
const MIN_VISIBLE_VOTES = 20;

export function SearchSection() {
  const [query, setQuery] = useState("");
  const [showNiche, setShowNiche] = useState(false);
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
    mutationFn: ({ input }: RequestMutationVariables) => createRequest(input),
    onSuccess: (data, variables) => {
      const key = requestKey(variables.input);
      const viewAction =
        data.id !== undefined
          ? {
              label: "View releases",
              onClick: () => {
                window.location.hash =
                  data.service === "sonarr"
                    ? `#/library/show/sonarr/${data.id}`
                    : `#/library/movie/radarr/${data.id}`;
              },
            }
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
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const requestingKey =
    requestMutation.isPending && requestMutation.variables
      ? requestKey(requestMutation.variables.input)
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

    requestMutation.mutate({ input, result });
  }

  const searchData = searchQuery.data;
  const allResults = searchData?.results ?? [];
  const visibleResults = showNiche
    ? allResults
    : allResults.filter((result) => (result.votes ?? 0) >= MIN_VISIBLE_VOTES);
  const hiddenCount = allResults.length - visibleResults.length;
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

      {searchData ? (
        <div className="flex items-center justify-end gap-2">
          <Switch
            id="show-niche-results"
            size="sm"
            checked={showNiche}
            onCheckedChange={setShowNiche}
          />
          <Label htmlFor="show-niche-results" className="text-xs font-normal text-muted-foreground">
            Show niche results
            {hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
          </Label>
        </div>
      ) : null}

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

      {searchEnabled && searchData && visibleResults.length > 0 ? (
        <SearchResultGrid
          results={visibleResults}
          onRequest={handleRequest}
          requestingKey={requestingKey}
          requestDisabled={optionsQuery.isLoading || requestMutation.isPending}
        />
      ) : null}

      {searchEnabled && searchData && visibleResults.length === 0 && hiddenCount > 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>
              Only niche results for “{searchData.query}”
            </EmptyTitle>
            <EmptyDescription>
              {hiddenCount} {hiddenCount === 1 ? "result has" : "results have"} fewer
              than {MIN_VISIBLE_VOTES} votes. Turn on “Show niche results” to see
              {hiddenCount === 1 ? " it" : " them"}.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
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

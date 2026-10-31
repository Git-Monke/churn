import { CircleAlertIcon, Settings2Icon } from "lucide-react";

import type {
  ArrRequestOptions,
  RequestMonitor,
  RequestOptionsResponse,
} from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MONITOR_LABELS } from "@/features/search/search-labels";
import type { RequestDefaults, ServiceRequestDefaults } from "@/features/search/use-request-defaults";

interface RequestOptionsPopoverProps {
  options?: RequestOptionsResponse;
  loading: boolean;
  error: Error | null;
  defaults: RequestDefaults;
  onChange: (service: "sonarr" | "radarr", patch: Partial<ServiceRequestDefaults>) => void;
}

export function RequestOptionsPopover({
  options,
  loading,
  error,
  defaults,
  onChange,
}: RequestOptionsPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={loading && !options}>
          <Settings2Icon data-icon="inline-start" />
          Request options
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(70vh,44rem)] w-[24rem] overflow-y-auto">
        <PopoverHeader>
          <PopoverTitle>Request defaults</PopoverTitle>
          <PopoverDescription>
            Used by the one-click Request button. Changes are saved in this browser.
          </PopoverDescription>
        </PopoverHeader>

        {error && !options ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Could not load request options</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}

        {options ? (
          <div className="flex flex-col gap-5">
            <ServiceOptions
              service={options.services.sonarr}
              defaults={defaults.sonarr}
              onChange={(patch) => onChange("sonarr", patch)}
            />
            <ServiceOptions
              service={options.services.radarr}
              defaults={defaults.radarr}
              onChange={(patch) => onChange("radarr", patch)}
            />
          </div>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading request options…</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ServiceOptions({
  service,
  defaults,
  onChange,
}: {
  service: ArrRequestOptions;
  defaults: ServiceRequestDefaults;
  onChange: (patch: Partial<ServiceRequestDefaults>) => void;
}) {
  const name = service.id === "sonarr" ? "Sonarr" : "Radarr";

  return (
    <FieldSet>
      <FieldLegend variant="label">{name}</FieldLegend>
      {service.state !== "ok" ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>{name} is not ready</AlertTitle>
          <AlertDescription>
            {service.detail ?? `Check that ${name} is running and its API key is configured.`}
          </AlertDescription>
        </Alert>
      ) : (
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor={`${service.id}-quality-profile`}>Quality profile</FieldLabel>
            <Select
              value={
                defaults.qualityProfileId === undefined
                  ? undefined
                  : String(defaults.qualityProfileId)
              }
              onValueChange={(value) =>
                onChange({ qualityProfileId: Number.parseInt(value, 10) })
              }
            >
              <SelectTrigger id={`${service.id}-quality-profile`} className="w-full">
                <SelectValue placeholder="Choose a profile" />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  {service.qualityProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={String(profile.id)}>
                      {profile.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${service.id}-root-folder`}>Root folder</FieldLabel>
            <Select
              value={defaults.rootFolderPath}
              onValueChange={(value) => onChange({ rootFolderPath: value })}
            >
              <SelectTrigger id={`${service.id}-root-folder`} className="w-full">
                <SelectValue placeholder="Choose a root folder" />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  {service.rootFolders.map((folder) => (
                    <SelectItem
                      key={folder.path}
                      value={folder.path}
                      disabled={!folder.accessible}
                    >
                      {folder.path}
                      {folder.accessible ? "" : " (inaccessible)"}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          {service.id === "sonarr" ? (
            <Field>
              <FieldLabel htmlFor="sonarr-monitor">Episodes to monitor</FieldLabel>
              <Select
                value={defaults.monitor ?? "all"}
                onValueChange={(value) =>
                  onChange({ monitor: value as RequestMonitor })
                }
              >
                <SelectTrigger id="sonarr-monitor" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectGroup>
                    {(Object.keys(MONITOR_LABELS) as RequestMonitor[]).map((monitor) => (
                      <SelectItem key={monitor} value={monitor}>
                        {MONITOR_LABELS[monitor]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${service.id}-search-on-add`}>Search on add</FieldLabel>
              <FieldDescription>
                Start looking for a download as soon as the title is requested.
              </FieldDescription>
            </FieldContent>
            <Switch
              id={`${service.id}-search-on-add`}
              checked={defaults.searchOnAdd}
              onCheckedChange={(checked) => onChange({ searchOnAdd: checked })}
            />
          </Field>
        </FieldGroup>
      )}
    </FieldSet>
  );
}

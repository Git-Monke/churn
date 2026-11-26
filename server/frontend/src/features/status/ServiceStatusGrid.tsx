import { useState } from "react";
import { ClapperboardIcon, ExternalLinkIcon, FilmIcon, TvIcon, type LucideIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import type { ServiceStatus } from "@/api/types";

interface ServiceStatusGridProps {
  services?: ServiceStatus[];
  loading: boolean;
  error: Error | null;
}

export function ServiceStatusGrid({ services, loading, error }: ServiceStatusGridProps) {
  if (loading && !services) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading title="Services" description="Sonarr finds TV and Radarr finds movies; qBittorrent downloads them and Jellyfin plays them." />
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-52 rounded-xl" />
          ))}
        </div>
      </section>
    );
  }

  if (error && !services) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load service status</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading title="Services" description="Sonarr finds TV and Radarr finds movies; qBittorrent downloads them and Jellyfin plays them." />
      <div className="grid gap-4 md:grid-cols-3">
        {services?.map((service) => (
          <ServiceCard key={service.id} service={service} />
        ))}
      </div>
    </section>
  );
}

/** What each service does for churn, in a line, plus a symbol if its logo cannot load. */
const SERVICE_ROLES: Record<ServiceStatus["id"], { role: string; fallback: LucideIcon }> = {
  jellyfin: { role: "Plays your library. Streams your movies and shows to any screen.", fallback: ClapperboardIcon },
  sonarr: { role: "Handles TV. Follows the shows you add and grabs each new episode as it airs.", fallback: TvIcon },
  radarr: { role: "Handles movies. Grabs the films you add and upgrades them to better copies.", fallback: FilmIcon },
};

function ServiceCard({ service }: { service: ServiceStatus }) {
  const role = SERVICE_ROLES[service.id];
  return (
    <Card size="sm" className="gap-3">
      <CardHeader className="flex items-start gap-3">
        <ServiceIcon id={service.id} fallback={role?.fallback} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <CardTitle>{service.name}</CardTitle>
          {role ? <CardDescription>{role.role}</CardDescription> : null}
        </div>
        <CardAction className="shrink-0">
          <StatusBadge state={service.state} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Separator />
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-medium">{service.version ?? "Unknown"}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">Latency</dt>
            <dd className="font-medium">
              {service.latencyMs === undefined ? "—" : `${service.latencyMs} ms`}
            </dd>
          </div>
        </dl>
        {service.detail ? <p className="text-sm text-muted-foreground">{service.detail}</p> : null}
      </CardContent>
      <CardFooter className="mt-auto">
        <Button asChild variant="outline" size="sm">
          <a href={`/api/services/${service.id}/open`} target="_blank" rel="noreferrer">
            Open {service.name}
            <ExternalLinkIcon data-icon="inline-end" />
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}

/** The service's own logo, served through churn; a matching symbol until it loads or if it can't. */
function ServiceIcon({ id, fallback: Fallback = FilmIcon }: { id: string; fallback?: LucideIcon }) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted"
    >
      {failed ? (
        <Fallback className="size-5 text-muted-foreground" />
      ) : (
        <img
          src={`/api/services/${encodeURIComponent(id)}/icon`}
          alt=""
          className="size-7 object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

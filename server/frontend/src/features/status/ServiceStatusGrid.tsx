import { ExternalLinkIcon } from "lucide-react";

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
        <SectionHeading title="Services" description="Jellyfin, Sonarr and Radarr health" />
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
      <SectionHeading title="Services" description="Jellyfin, Sonarr and Radarr health" />
      <div className="grid gap-4 md:grid-cols-3">
        {services?.map((service) => (
          <ServiceCard key={service.id} service={service} />
        ))}
      </div>
    </section>
  );
}

function ServiceCard({ service }: { service: ServiceStatus }) {
  return (
    <Card size="sm" className="gap-3">
      <CardHeader>
        <CardTitle>{service.name}</CardTitle>
        <CardDescription className="truncate">{service.url}</CardDescription>
        <CardAction>
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

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

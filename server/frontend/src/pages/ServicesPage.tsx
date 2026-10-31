import { CircleAlertIcon } from "lucide-react";

import type { StatusResponse } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ServiceStatusGrid } from "@/features/status/ServiceStatusGrid";

interface ServicesPageProps {
  status?: StatusResponse;
  loading: boolean;
  error: Error | null;
}

export function ServicesPage({ status, loading, error }: ServicesPageProps) {
  return (
    <div className="flex flex-col gap-6">
      {error && status ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Service status is stale</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <ServiceStatusGrid services={status?.services} loading={loading} error={error} />
    </div>
  );
}

import { CircleAlertIcon } from "lucide-react";

import type { StatusResponse } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ServiceStatusGrid } from "@/features/status/ServiceStatusGrid";
import { StatsPanel } from "@/features/stats/StatsPanel";
import { VpnStatusPanel } from "@/features/vpn/VpnStatusPanel";

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
      <Tabs defaultValue="services" className="gap-4">
        <TabsList>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="stats">Stats</TabsTrigger>
          <TabsTrigger value="vpn">VPN</TabsTrigger>
        </TabsList>
        <TabsContent value="services">
          <ServiceStatusGrid services={status?.services} loading={loading} error={error} />
        </TabsContent>
        <TabsContent value="stats">
          <StatsPanel />
        </TabsContent>
        <TabsContent value="vpn">
          <VpnStatusPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

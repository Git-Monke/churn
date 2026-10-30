import { CircleAlertIcon, CircleCheckIcon, CircleHelpIcon, CircleXIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ServiceState } from "@/api/types";

const labels: Record<ServiceState, string> = {
  ok: "Online",
  unconfigured: "Needs setup",
  unauthorized: "Key rejected",
  unreachable: "Unreachable",
};

export function StatusBadge({ state }: { state: ServiceState }) {
  if (state === "ok") {
    return (
      <Badge variant="default">
        <CircleCheckIcon data-icon="inline-start" />
        {labels.ok}
      </Badge>
    );
  }
  if (state === "unconfigured") {
    return (
      <Badge variant="outline">
        <CircleHelpIcon data-icon="inline-start" />
        {labels.unconfigured}
      </Badge>
    );
  }
  if (state === "unauthorized") {
    return (
      <Badge variant="destructive">
        <CircleXIcon data-icon="inline-start" />
        {labels.unauthorized}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <CircleAlertIcon data-icon="inline-start" />
      {labels.unreachable}
    </Badge>
  );
}

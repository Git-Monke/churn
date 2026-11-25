import { CircleAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { useDiskShareSummary } from "@/features/disk-share/use-disk-share";
import { formatBytes } from "@/lib/format";

/** Warns on the library page once a person is within 10% of their share. */
export function NearLimitBanner() {
  const summary = useDiskShareSummary().data;
  if (!summary?.nearLimit || summary.limitBytes === null) {
    return null;
  }

  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertDescription>
        You're close to your download limit: {formatBytes(summary.usedBytes)} of{" "}
        {formatBytes(summary.limitBytes)} used. Remove something you've finished
        with to free space.
      </AlertDescription>
    </Alert>
  );
}
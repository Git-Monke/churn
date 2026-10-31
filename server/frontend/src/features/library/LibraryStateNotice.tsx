import { CircleAlertIcon } from "lucide-react";

import type { LibraryResponse } from "@/api/types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function LibraryStateNotice({
  library,
  jellyfinUrl,
}: {
  library: LibraryResponse;
  jellyfinUrl?: string;
}) {
  if (library.state === "setup_required") {
    return (
      <Alert>
        <CircleAlertIcon />
        <AlertTitle>Finish Jellyfin setup</AlertTitle>
        <AlertDescription>
          Jellyfin&apos;s first-run wizard is not complete, so there is no library to show yet.
          Re-run the churn installer to finish setup and create the dashboard API key, or
          complete the wizard and add <code>JELLYFIN_API_KEY</code> to <code>server/.env</code>.
        </AlertDescription>
        <AlertAction>
          <Button asChild variant="outline" size="sm">
            <a href="/api/services/jellyfin/open" target="_blank" rel="noreferrer">
              Open Jellyfin
            </a>
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (library.state === "unconfigured") {
    return (
      <Alert>
        <CircleAlertIcon />
        <AlertTitle>Jellyfin API key required</AlertTitle>
        <AlertDescription>
          Re-run the churn installer to create the dashboard API key, or add
          <code>JELLYFIN_API_KEY</code> to <code>server/.env</code> and restart the backend.
          You can create a key in Jellyfin under Dashboard → API Keys.
        </AlertDescription>
        <AlertAction>
          <Button asChild variant="outline" size="sm">
            <a href="/api/services/jellyfin/open" target="_blank" rel="noreferrer">
              Open Jellyfin
            </a>
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (library.state === "unauthorized") {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Jellyfin rejected the API key</AlertTitle>
        <AlertDescription>
          Check <code>JELLYFIN_API_KEY</code> in <code>server/.env</code> and restart the
          backend. You can create a new key in Jellyfin under Dashboard → API Keys.
        </AlertDescription>
        <AlertAction>
          <Button asChild variant="outline" size="sm">
            <a href="/api/services/jellyfin/open" target="_blank" rel="noreferrer">
              Open Jellyfin
            </a>
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>Jellyfin is unreachable</AlertTitle>
      <AlertDescription>
        Could not reach {jellyfinUrl ?? "Jellyfin"}. Check that the Jellyfin container is running
        and that <code>JELLYFIN_URL</code> is correct.
        {library.detail ? ` ${library.detail}` : ""}
      </AlertDescription>
    </Alert>
  );
}

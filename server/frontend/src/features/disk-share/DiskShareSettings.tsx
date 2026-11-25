import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import type { DiskShareUserShare, ManagedProfile } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useDiskShareLimit } from "@/features/disk-share/use-disk-share";
import { formatBytes } from "@/lib/format";

const BYTES_PER_GIGABYTE = 1024 ** 3;

export function DiskShareSettings({
  enabled,
  pending,
  onEnabledChange,
}: {
  enabled: boolean;
  pending: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label
        htmlFor="disk-share-enabled"
        className="text-sm font-normal text-muted-foreground"
      >
        Limit each person's downloads
      </Label>
      <Switch
        id="disk-share-enabled"
        checked={enabled}
        disabled={pending}
        onCheckedChange={onEnabledChange}
      />
    </div>
  );
}

export function DiskShareLimitDialog({
  profile,
  share,
  onClose,
}: {
  profile: ManagedProfile;
  share: DiskShareUserShare;
  onClose: () => void;
}) {
  const mutation = useDiskShareLimit();
  const [value, setValue] = useState(() =>
    share.limitBytes === null ? "" : (share.limitBytes / BYTES_PER_GIGABYTE).toFixed(1),
  );
  const gigabytes = Number.parseFloat(value);
  const valid = Number.isFinite(gigabytes) && gigabytes > 0;

  function closeAfterSuccess() {
    toast.success(`Updated limits for ${profile.name}`);
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Download limit for {profile.name}</DialogTitle>
          <DialogDescription>
            {share.customLimit && share.limitBytes !== null
              ? `Custom limit: ${formatBytes(share.limitBytes)}.`
              : "This person currently gets an equal share of the library disk."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="disk-share-limit">Limit in GB</Label>
          <Input
            id="disk-share-limit"
            type="number"
            inputMode="decimal"
            min="0.1"
            step="0.1"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={mutation.isPending}
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={mutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="outline"
            disabled={mutation.isPending || !share.customLimit}
            onClick={() =>
              mutation.mutate(
                { profileId: profile.id, limitBytes: null },
                { onSuccess: closeAfterSuccess },
              )
            }
          >
            Use equal share
          </Button>
          <Button
            disabled={mutation.isPending || !valid}
            onClick={() =>
              mutation.mutate(
                {
                  profileId: profile.id,
                  limitBytes: Math.round(gigabytes * BYTES_PER_GIGABYTE),
                },
                { onSuccess: closeAfterSuccess },
              )
            }
          >
            {mutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : null}
            Save limit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
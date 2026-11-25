import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  fetchDiskShare,
  fetchDiskShareAdmin,
  setDiskShareLimit,
  updateDiskShareSettings,
} from "@/api/client";

const SUMMARY_KEY = ["disk-share"] as const;
const ADMIN_KEY = ["disk-share-admin"] as const;

function invalidateShares(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
  void queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
}

export function useDiskShareSummary() {
  return useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: fetchDiskShare,
    staleTime: 30_000,
    // Torrents finish and imports land without a client event, so poll.
    refetchInterval: 15_000,
  });
}

export function useDiskShareAdmin() {
  return useQuery({
    queryKey: ADMIN_KEY,
    queryFn: fetchDiskShareAdmin,
    staleTime: 30_000,
  });
}

export function useDiskShareSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => updateDiskShareSettings({ enabled }),
    onSuccess: () => invalidateShares(queryClient),
    onError: (error) => {
      toast.error("Could not update download limits", { description: error.message });
    },
  });
}

export function useDiskShareLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { profileId: string; limitBytes: number | null }) =>
      setDiskShareLimit(input.profileId, input.limitBytes),
    onSuccess: () => invalidateShares(queryClient),
    onError: (error) => {
      toast.error("Could not update download limits", { description: error.message });
    },
  });
}
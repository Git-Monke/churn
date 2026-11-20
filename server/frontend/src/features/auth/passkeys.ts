import {
  browserSupportsWebAuthn,
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";

import { beginPasskeyLogin, fetchPasskeyAvailability, finishPasskeyLogin } from "@/api/client";

export function usePasskeyAvailability() {
  const { data } = useQuery({
    queryKey: ["passkey-availability"],
    queryFn: fetchPasskeyAvailability,
    staleTime: 60_000,
    retry: false,
  });
  return window.isSecureContext && data?.origin === window.location.origin;
}

export function canUsePasskeys() {
  return browserSupportsWebAuthn();
}

export async function signInWithPasskey(signal: AbortSignal, autofill = false) {
  const optionsJSON = await beginPasskeyLogin();
  if (signal.aborted) return;
  const abort = () => WebAuthnAbortService.cancelCeremony();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
    if (!signal.aborted) return await finishPasskeyLogin(response);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function passkeyErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError" ||
        ("code" in error && error.code === "ERROR_CEREMONY_ABORTED")) {
      return "The passkey prompt was dismissed. You can try again.";
    }
    return error.message || fallback;
  }
  return fallback;
}

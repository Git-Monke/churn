import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";

import {
  beginPasskeyLogin,
  beginPasskeyRegistration,
  cancelPasskeyRegistration,
  fetchPasskeyAvailability,
  finishPasskeyLogin,
  finishPasskeyRegistration,
  type PasskeyEnrollInput,
} from "@/api/client";

export function usePasskeyAvailability() {
  const { data } = useQuery({
    queryKey: ["passkey-availability"],
    queryFn: fetchPasskeyAvailability,
    staleTime: 60_000,
    retry: false,
  });
  const configured = data?.origin ?? null;
  return {
    available: window.isSecureContext && configured === window.location.origin,
    configured,
  };
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

/**
 * Creates a passkey from the sign-in screen: the password identifies the
 * person, the ceremony proves the authenticator, and the server answers with
 * a session for the passkey's owner.
 */
export async function createPasskey(input: PasskeyEnrollInput) {
  const optionsJSON = await beginPasskeyRegistration(input);
  let started = false;
  try {
    started = true;
    const credential = await startRegistration({ optionsJSON });
    return await finishPasskeyRegistration(credential);
  } catch (caught) {
    if (started) await cancelPasskeyRegistration().catch(() => undefined);
    throw caught;
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

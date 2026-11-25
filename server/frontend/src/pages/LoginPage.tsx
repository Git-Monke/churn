import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { browserSupportsWebAuthnAutofill } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  LogInIcon,
  FingerprintIcon,
  ShieldIcon,
} from "lucide-react";

import { ApiClientError, fetchProfiles } from "@/api/client";
import type { ProfileSummary } from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  canUsePasskeys,
  createPasskey,
  passkeyErrorMessage,
  signInWithPasskey,
  usePasskeyAvailability,
} from "@/features/auth/passkeys";

type ProfileStep = "password" | "newPassword";

/**
 * First letter of every person's name, widened to two letters for anyone whose
 * first letter another person already uses.
 */
function profileInitials(profiles: ProfileSummary[]) {
  const counts = new Map<string, number>();
  const firsts = profiles.map((profile) => {
    const first = profile.name.trim().charAt(0).toUpperCase() || "?";
    counts.set(first, (counts.get(first) ?? 0) + 1);
    return first;
  });

  const initials = new Map<string, string>();
  profiles.forEach((profile, index) => {
    const first = firsts[index] ?? "?";
    if ((counts.get(first) ?? 0) < 2) {
      initials.set(profile.id, first);
      return;
    }
    const second = profile.name
      .trim()
      .slice(1)
      .replace(/\s+/g, "")
      .charAt(0)
      .toUpperCase();
    initials.set(profile.id, second ? `${first}${second}` : first);
  });
  return initials;
}

export function LoginPage() {
  const { login, profileLogin, isPending, applySession } = useAuth();
  const { available: passkeysAvailable, configured: passkeyOrigin } = usePasskeyAvailability();
  const passkeys = passkeysAvailable && canUsePasskeys();
  const [passkeyPending, setPasskeyPending] = useState(false);
  const prompt = useRef<AbortController | null>(null);
  useEffect(() => () => prompt.current?.abort(), []);
  const [passwordMode, setPasswordMode] = useState<"sign-in" | "setup" | null>(null);
  const [passkeySetup, setPasskeySetup] = useState(false);
  const [passkeyName, setPasskeyName] = useState("");
  const [selected, setSelected] = useState<ProfileSummary | null>(null);
  const [stage, setStage] = useState<"pick" | "password">("pick");
  const [pin, setPin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordStep, setPasswordStep] = useState<ProfileStep>("password");
  const [error, setError] = useState<string | null>(null);
  const busy = isPending || passkeyPending;

  const profilesQuery = useQuery({
    queryKey: ["auth-profiles"],
    queryFn: fetchProfiles,
    retry: false,
  });
  const people = useMemo(() => profilesQuery.data ?? [], [profilesQuery.data]);
  const initialsById = useMemo(() => profileInitials(people), [people]);

  async function usePasskey() {
    const controller = new AbortController();
    prompt.current = controller;
    setError(null);
    setPasskeyPending(true);
    try {
      const session = await signInWithPasskey(controller.signal);
      if (session) applySession(session);
    } catch (caught) {
      if (!controller.signal.aborted) setError(passkeyErrorMessage(caught, "Could not sign in with a passkey."));
    } finally {
      if (!controller.signal.aborted) setPasskeyPending(false);
    }
  }

  function resetProfileFlow() {
    setSelected(null);
    setStage("pick");
    setPin("");
    setNewPassword("");
    setPasswordStep("password");
    setPasskeyName("");
    setError(null);
  }

  async function selectProfile(profile: ProfileSummary) {
    setSelected(profile);
    setStage("password");
    setPin("");
    setNewPassword("");
    setPasswordStep("password");
    setPasskeyName(passkeySetup ? `${profile.name}'s Passkey` : "");
    setError(null);
  }

  async function onProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) {
      return;
    }
    setError(null);
    if (!pin) {
      setError(
        selected.passwordSet
          ? "Enter your password."
          : "Enter the PIN your admin gave you.",
      );
      return;
    }

    if (passkeySetup) {
      await addPasskey();
      return;
    }

    try {
      if (!selected.passwordSet && passwordStep === "newPassword") {
        if (newPassword.length < 12) {
          setError("Choose a password with at least 12 characters, upper and lower case, a number, and a symbol.");
          return;
        }
        await profileLogin({
          profileId: selected.id,
          password: pin,
          newPassword,
        });
        return;
      }

      const response = await profileLogin({
        profileId: selected.id,
        password: pin,
      });
      if (response.passwordSetupRequired) {
        setPasswordSetup(selected);
        return;
      }
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : "Could not sign in. Check that Jellyfin is running.",
      );
    }
  }

  async function addPasskey() {
    if (!selected) {
      return;
    }
    const label = passkeyName.trim();
    if (!label) {
      setError("Name the passkey so you can recognize it later.");
      return;
    }
    setError(null);
    setPasskeyPending(true);
    try {
      applySession(await createPasskey({ profileId: selected.id, password: pin, label }));
    } catch (caught) {
      setError(passkeyErrorMessage(caught, "Could not add the passkey."));
    } finally {
      setPasskeyPending(false);
    }
  }

  function setPasswordSetup(profile: ProfileSummary) {
    setSelected({ ...profile, passwordSet: false });
    setStage("password");
    setPasswordStep("newPassword");
    setNewPassword("");
    setError(null);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Churn</h1>
          <p className="text-sm text-muted-foreground">
            {passwordMode
              ? "Sign in with a Jellyfin account."
              : passkeySetup
                ? "Choose a person to set up a passkey for."
                : "Who's watching?"}
          </p>
        </div>

        {passwordMode ? (
          <AdminSignIn
            passkeys={passkeys && passwordMode === "sign-in"}
            setupPasskey={passwordMode === "setup"}
            isPending={busy}
            onCancel={() => {
              setPasswordMode(null);
              setError(null);
            }}
            onSubmit={async (username, password, label) => {
              setError(null);
              try {
                if (passwordMode === "setup") {
                  applySession(await createPasskey({ username, password, label }));
                  return;
                }
                await login({ username, password });
              } catch (caught) {
                setError(
                  passwordMode === "setup"
                    ? passkeyErrorMessage(caught, "Could not add the passkey.")
                    : caught instanceof ApiClientError
                      ? caught.message
                      : "Could not sign in. Check that Jellyfin is running.",
                );
              }
            }}
            error={error}
          />
        ) : selected && stage === "password" ? (
          <Card>
            <CardHeader>
              <CardTitle>
                {passkeySetup
                  ? `Add a passkey for ${selected.name}`
                  : passwordStep === "newPassword"
                    ? `Welcome, ${selected.name}`
                    : `Sign in as ${selected.name}`}
              </CardTitle>
              <CardDescription>
                {passkeySetup
                  ? "Name the passkey and enter this person's password. The passkey will sign them in from now on."
                  : selected.passwordSet
                    ? "Enter your password to open the dashboard."
                    : passwordStep === "newPassword"
                      ? "Choose a password you will use from now on."
                      : "First sign-in: enter the PIN your admin gave you. You will choose your own password next."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => void onProfileSubmit(event)}
              >
                {passkeySetup ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="passkey-name">Passkey name</Label>
                    <Input
                      id="passkey-name"
                      name="passkey-name"
                      autoComplete="off"
                      autoFocus
                      required
                      maxLength={50}
                      value={passkeyName}
                      onChange={(event) => setPasskeyName(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                ) : null}

                {passwordStep === "password" ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="profile-password">
                      {selected.passwordSet ? "Password" : "PIN"}
                    </Label>
                    <PasswordInput
                      id="profile-password"
                      name="password"
                      inputMode={selected.passwordSet ? undefined : "numeric"}
                      autoComplete="current-password"
                      autoFocus={!passkeySetup}
                      value={pin}
                      onChange={(event) => setPin(event.target.value)}
                      disabled={isPending}
                    />
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="profile-new-password">New password</Label>
                    <PasswordInput
                      id="profile-new-password"
                      name="new-password"
                      autoComplete="new-password"
                      autoFocus
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      disabled={isPending}
                    />
                  </div>
                )}

                {error ? <SignInError message={error} /> : null}

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resetProfileFlow}
                    disabled={busy}
                  >
                    <ArrowLeftIcon data-icon="inline-start" />
                    Back
                  </Button>
                  <Button type="submit" className="sm:flex-1" disabled={busy}>
                    {passkeySetup ? (
                      <FingerprintIcon data-icon="inline-start" />
                    ) : (
                      <LogInIcon data-icon="inline-start" />
                    )}
                    {busy
                      ? passkeySetup
                        ? "Adding passkey…"
                        : "Signing in…"
                      : passkeySetup
                        ? "Add passkey"
                        : passwordStep === "newPassword"
                          ? "Set password & sign in"
                          : "Sign in"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : (
          <div className="flex w-full flex-col items-center gap-6">
            {profilesQuery.isLoading ? (
              <div className="flex gap-5" aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="flex flex-col items-center gap-3">
                    <Skeleton className="size-26" />
                    <Skeleton className="h-2.5 w-14" />
                  </div>
                ))}
              </div>
            ) : profilesQuery.isError ? (
              <SignInError message="Could not load the people list." />
            ) : (
              <>
                {error ? <SignInError message={error} /> : null}

                <ul className="flex flex-wrap items-start justify-center gap-4 sm:gap-5">
                  {people.map((profile) => {
                    const initials = initialsById.get(profile.id) ?? "?";
                    return (
                      <li
                        key={profile.id}
                        className="group flex flex-col items-center gap-3"
                      >
                        <button
                          type="button"
                          aria-label={
                            passkeySetup
                              ? `Set up a passkey for ${profile.name}`
                              : `Sign in as ${profile.name}`
                          }
                          disabled={
                            passkeyPending ||
                            (passkeySetup && !profile.passwordSet)
                          }
                          onClick={() => void selectProfile(profile)}
                          className="flex size-24 items-center justify-center border border-border bg-muted font-heading font-semibold tracking-tight text-foreground transition-colors hover:border-primary hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-primary sm:size-26"
                        >
                          <span
                            className={
                              initials.length > 1
                                ? "text-2xl tracking-normal"
                                : "text-4xl"
                            }
                          >
                            {initials}
                          </span>
                        </button>
                        <span
                          title={profile.name}
                          className="max-w-24 truncate text-xs uppercase tracking-[0.07em] text-muted-foreground transition-colors group-hover:text-foreground sm:max-w-26"
                        >
                          {profile.name}
                        </span>
                        {profile.passwordSet ? null : (
                          <span className="-mt-2 text-[10px] uppercase tracking-[0.07em] text-muted-foreground/80">
                            {passkeySetup ? "No password yet" : "PIN not set"}
                          </span>
                        )}
                      </li>
                    );
                  })}

                  <li className="group flex flex-col items-center gap-3">
                    <button
                      type="button"
                      aria-label={
                        passkeySetup
                          ? "Set up a passkey for the admin account"
                          : "Admin sign in"
                      }
                      disabled={passkeyPending}
                      onClick={() => {
                        setPasswordMode(passkeySetup ? "setup" : "sign-in");
                        setError(null);
                      }}
                      className="flex size-24 items-center justify-center border border-input text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-primary sm:size-26"
                    >
                      <ShieldIcon className="size-8" strokeWidth={1.5} />
                    </button>
                    <span className="text-xs uppercase tracking-[0.07em] text-muted-foreground transition-colors group-hover:text-foreground">
                      Admin
                    </span>
                  </li>
                </ul>

                {passkeySetup ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPasskeySetup(false);
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                ) : passkeys ? (
                  <div className="flex w-full max-w-xs flex-col gap-2">
                    <Button type="button" onClick={() => void usePasskey()} disabled={passkeyPending}>
                      <FingerprintIcon data-icon="inline-start" />
                      {passkeyPending ? "Waiting for your passkey…" : "Sign in with a passkey"}
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      className="self-center"
                      disabled={passkeyPending}
                      onClick={() => {
                        setPasskeySetup(true);
                        setError(null);
                      }}
                    >
                      Set up a passkey
                    </Button>
                  </div>
                ) : null}

                {passkeyOrigin && passkeyOrigin !== window.location.origin ? (
                  <p className="w-full max-w-xs text-center text-xs text-muted-foreground">
                    Passkeys are set up for {passkeyOrigin}. Open that address to
                    use them.
                  </p>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function AdminSignIn({
  passkeys,
  setupPasskey,
  isPending,
  error,
  onCancel,
  onSubmit,
}: {
  passkeys: boolean;
  setupPasskey: boolean;
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (username: string, password: string, label: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState<string | null>(null);
  const [useAutofill, setUseAutofill] = useState(passkeys);
  const { applySession } = useAuth();
  const passkeyName = label ?? (username.trim() ? `${username.trim()}'s Passkey` : "");

  useEffect(() => {
    if (!useAutofill) return;
    const controller = new AbortController();
    void (async () => {
      try {
        if (await browserSupportsWebAuthnAutofill() && !controller.signal.aborted) {
          const session = await signInWithPasskey(controller.signal, true);
          if (session) applySession(session);
        }
      } catch {
        // Password entry remains available when autofill is dismissed or unsupported.
      }
    })();
    return () => controller.abort();
  }, [applySession, useAutofill]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password || (setupPasskey && !passkeyName.trim())) {
      return;
    }
    setUseAutofill(false);
    await onSubmit(username.trim(), password, setupPasskey ? passkeyName.trim() : "");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{setupPasskey ? "Set up a passkey" : "Sign in with a password"}</CardTitle>
        <CardDescription>
          {setupPasskey ? "Enter your Jellyfin account and name the new passkey." : "Use your Jellyfin account."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete={passkeys ? "username webauthn" : "username"}
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={isPending}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isPending}
            />
          </div>
          {setupPasskey ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="passkey-name">Passkey name</Label>
              <Input
                id="passkey-name"
                name="passkey-name"
                autoComplete="off"
                required
                maxLength={50}
                value={passkeyName}
                onChange={(event) => setLabel(event.target.value)}
                disabled={isPending}
              />
            </div>
          ) : null}

          {error ? <SignInError message={error} /> : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={isPending}
            >
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
            <Button type="submit" className="sm:flex-1" disabled={isPending}>
              {setupPasskey ? (
                <FingerprintIcon data-icon="inline-start" />
              ) : (
                <LogInIcon data-icon="inline-start" />
              )}
              {isPending
                ? setupPasskey
                  ? "Adding passkey…"
                  : "Signing in…"
                : setupPasskey
                  ? "Add passkey"
                  : "Sign in"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SignInError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>Sign-in failed</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

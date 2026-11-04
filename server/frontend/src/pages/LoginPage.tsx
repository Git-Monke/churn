import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  LogInIcon,
  ShieldIcon,
  UserRoundIcon,
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/AuthProvider";

type ProfileStep = "password" | "newPassword";

export function LoginPage() {
  const { login, profileLogin, isPending } = useAuth();
  const [showAdmin, setShowAdmin] = useState(false);
  const [selected, setSelected] = useState<ProfileSummary | null>(null);
  const [stage, setStage] = useState<"pick" | "password">("pick");
  const [pin, setPin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordStep, setPasswordStep] = useState<ProfileStep>("password");
  const [error, setError] = useState<string | null>(null);

  const profilesQuery = useQuery({
    queryKey: ["auth-profiles"],
    queryFn: fetchProfiles,
    retry: false,
  });

  function resetProfileFlow() {
    setSelected(null);
    setStage("pick");
    setPin("");
    setNewPassword("");
    setPasswordStep("password");
    setError(null);
  }

  async function selectProfile(profile: ProfileSummary) {
    setSelected(profile);
    setStage("password");
    setPin("");
    setNewPassword("");
    setPasswordStep("password");
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

    try {
      if (!selected.passwordSet && passwordStep === "newPassword") {
        if (newPassword.length < 8) {
          setError("Choose a password with at least 8 characters.");
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
            {showAdmin
              ? "Sign in with a Jellyfin account to manage people."
              : "Who's watching?"}
          </p>
        </div>

        {showAdmin ? (
          <AdminSignIn
            isPending={isPending}
            onCancel={() => {
              setShowAdmin(false);
              setError(null);
            }}
            onSubmit={async (username, password) => {
              setError(null);
              try {
                await login({ username, password });
              } catch (caught) {
                setError(
                  caught instanceof ApiClientError
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
                {passwordStep === "newPassword"
                  ? `Welcome, ${selected.name}`
                  : `Sign in as ${selected.name}`}
              </CardTitle>
              <CardDescription>
                {selected.passwordSet
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
                {passwordStep === "password" ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="profile-password">
                      {selected.passwordSet ? "Password" : "PIN"}
                    </Label>
                    <Input
                      id="profile-password"
                      name="password"
                      type="password"
                      inputMode={selected.passwordSet ? undefined : "numeric"}
                      autoComplete="current-password"
                      autoFocus
                      value={pin}
                      onChange={(event) => setPin(event.target.value)}
                      disabled={isPending}
                    />
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="profile-new-password">New password</Label>
                    <Input
                      id="profile-new-password"
                      name="new-password"
                      type="password"
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
                    disabled={isPending}
                  >
                    <ArrowLeftIcon data-icon="inline-start" />
                    Back
                  </Button>
                  <Button type="submit" className="sm:flex-1" disabled={isPending}>
                    <LogInIcon data-icon="inline-start" />
                    {isPending
                      ? "Signing in…"
                      : passwordStep === "newPassword"
                        ? "Set password & sign in"
                        : "Sign in"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>People</CardTitle>
              <CardDescription>
                Pick your profile to sign in. Each person gets their own watch
                progress.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {profilesQuery.isLoading ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  <Skeleton className="h-20 rounded-xl" />
                  <Skeleton className="h-20 rounded-xl" />
                  <Skeleton className="h-20 rounded-xl" />
                </div>
              ) : profilesQuery.isError ? (
                <SignInError message="Could not load the people list." />
              ) : profilesQuery.data && profilesQuery.data.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  {profilesQuery.data.map((profile) => (
                    <Button
                      key={profile.id}
                      type="button"
                      variant="outline"
                      className="h-auto flex-col gap-2 py-5"
                      onClick={() => void selectProfile(profile)}
                    >
                      <UserRoundIcon className="size-6" />
                      <span className="font-medium">{profile.name}</span>
                      {!profile.passwordSet ? (
                        <span className="text-xs text-muted-foreground">
                          PIN not set up yet
                        </span>
                      ) : null}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No people have been added yet. An admin can create them from the
                  People page.
                </p>
              )}

              {error ? <SignInError message={error} /> : null}

              <Button
                type="button"
                variant="ghost"
                className="self-start"
                onClick={() => {
                  setShowAdmin(true);
                  setError(null);
                }}
              >
                <ShieldIcon data-icon="inline-start" />
                Admin sign in
              </Button>
            </CardContent>
          </Card>
        )}

        <p className="text-center text-xs text-muted-foreground">
          Sessions last 12 hours of inactivity and survive dashboard restarts.
        </p>
      </div>
    </main>
  );
}

function AdminSignIn({
  isPending,
  error,
  onCancel,
  onSubmit,
}: {
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password) {
      return;
    }
    await onSubmit(username.trim(), password);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin sign in</CardTitle>
        <CardDescription>
          Use a Jellyfin administrator account to add and manage people. Other
          Jellyfin accounts can still sign in here too.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={isPending}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isPending}
            />
          </div>

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
              <LogInIcon data-icon="inline-start" />
              {isPending ? "Signing in…" : "Sign in"}
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

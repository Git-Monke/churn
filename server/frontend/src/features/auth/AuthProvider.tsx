import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchSession,
  login as loginRequest,
  logout as logoutRequest,
} from "@/api/client";
import type {
  AuthSessionResponse,
  LoginInput,
  LoginResponse,
} from "@/api/types";

interface AuthContextValue {
  session: AuthSessionResponse | undefined;
  isLoading: boolean;
  isPending: boolean;
  login: (input: LoginInput) => Promise<LoginResponse>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const SESSION_QUERY_KEY = ["auth-session"] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    retry: false,
    staleTime: 60_000,
  });

  const loginMutation = useMutation({
    mutationFn: loginRequest,
    onSuccess: (data) => {
      queryClient.getQueryCache().clear();
      queryClient.setQueryData<AuthSessionResponse>(SESSION_QUERY_KEY, {
        authenticated: true,
        user: data.user,
        expiresAt: data.expiresAt,
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: logoutRequest,
    onSettled: () => {
      queryClient.getQueryCache().clear();
      queryClient.setQueryData<AuthSessionResponse>(SESSION_QUERY_KEY, {
        authenticated: false,
      });
    },
  });

  useEffect(() => {
    const handleUnauthorized = () => {
      queryClient.getQueryCache().clear();
      queryClient.setQueryData<AuthSessionResponse>(SESSION_QUERY_KEY, {
        authenticated: false,
      });
    };
    window.addEventListener("churn:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("churn:unauthorized", handleUnauthorized);
  }, [queryClient]);

  const login = useCallback(
    (input: LoginInput) => loginMutation.mutateAsync(input),
    [loginMutation],
  );
  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch {
      // The local session is cleared by onSettled even if the request fails.
    }
  }, [logoutMutation]);

  return (
    <AuthContext.Provider
      value={{
        session: sessionQuery.data,
        isLoading: sessionQuery.isLoading,
        isPending: loginMutation.isPending || logoutMutation.isPending,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return value;
}

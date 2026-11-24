import { createContext, useContext, type ReactNode } from "react";

import type { SpawnpointApi } from "./contract";

/** What the build knows about sign-in before any request: whether an API is set, and the public client ids. */
export type SignInConfig = Readonly<{ configured: boolean; telegramClientId: string; googleClientId: string }>;

export type Composition = Readonly<{ api: SpawnpointApi; signIn: SignInConfig }>;

const CompositionContext = createContext<Composition | null>(null);

/** Hands the composed API to everything below. Only the entry point builds a composition. */
export function ApiProvider({ composition, children }: Readonly<{ composition: Composition; children: ReactNode }>) {
  return <CompositionContext.Provider value={composition}>{children}</CompositionContext.Provider>;
}

function useComposition(): Composition {
  const composition = useContext(CompositionContext);
  if (composition === null) throw new Error("useApi needs an ApiProvider above it.");
  return composition;
}

export const useApi = (): SpawnpointApi => useComposition().api;
export const useSignInConfig = (): SignInConfig => useComposition().signIn;

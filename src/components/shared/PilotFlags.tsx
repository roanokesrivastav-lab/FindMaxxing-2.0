"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { PilotFeature } from "@/lib/config";

type Flags = Partial<Record<PilotFeature, boolean>>;
const PilotFlagsContext = createContext<Flags>({});

/**
 * Pilot flags resolved on the server (pilotFlags() in the root layout) and
 * handed to client components, which must not read the environment themselves.
 * Outside the provider every flag is off.
 */
export function PilotFlagsProvider({ flags, children }: { flags: Flags; children: ReactNode }) {
  return <PilotFlagsContext.Provider value={flags}>{children}</PilotFlagsContext.Provider>;
}

export function usePilotFlag(flag: PilotFeature): boolean {
  return useContext(PilotFlagsContext)[flag] === true;
}

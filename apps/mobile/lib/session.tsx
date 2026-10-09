import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

interface SessionState {
  session: Session | null;
  userId: string | null;
  loading: boolean;
}

const SessionContext = createContext<SessionState>({ session: null, userId: null, loading: true });

/** The signed-in person, kept in step with Supabase Auth. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, userId: null, loading: !!supabase });
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setState({ session: data.session, userId: data.session?.user.id ?? null, loading: false }));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setState({ session, userId: session?.user.id ?? null, loading: false }));
    return () => data.subscription.unsubscribe();
  }, []);
  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

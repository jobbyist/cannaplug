import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { sameUser } from "@/lib/auth-user";

type AuthState = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Supabase hands out a new session object on every token refresh, in this tab and (through its broadcast)
  // in every other open tab, roughly hourly. Keep the *user* object the same while it is the same person with
  // the same profile, so pages keyed on the user (e.g. /admin) don't reload and lose what is on screen.
  const stableUser = useRef<User | null>(null);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    supabase.auth.getSession().then(({ data: result }) => {
      setSession(result.session);
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const nextUser = session?.user ?? null;
  if (!sameUser(stableUser.current, nextUser)) stableUser.current = nextUser;
  const user = stableUser.current;

  const value = useMemo<AuthState>(
    () => ({
      user,
      session,
      loading,
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [user, session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

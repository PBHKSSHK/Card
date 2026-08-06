import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./supabase";
import { queryClient } from "@/lib/queryClient";
import type { Session, User } from "@supabase/supabase-js";

export type UserRole = "owner" | "admin" | "bu_user";

export interface UserProfile {
  user_id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  // BU user 的 entity_code list；owner / admin 為空陣列 = 全部
  entity_scope: string[];
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: UserProfile | null;
  // 兩者 (owner + admin) 都係 super
  isAdmin: boolean;
  isOwner: boolean;
  isSuperUser: boolean;
  // BU user
  isBuUser: boolean;
  // 取得當前 user 嘅 entity scope (super 用戶 return ["__ALL__"])
  entityScope: string[];
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, displayName: string) => Promise<{ error: string | null }>;
  // 主要 login 方法—用 Magic Link，嘔使 password
  signInWithMagicLink: (email: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = async (userId: string) => {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("user_id, email, full_name, role, entity_scope")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.error("[auth] fetchProfile error:", error);
      setProfile(null);
      return;
    }
    if (data) {
      setProfile({
        user_id: data.user_id,
        email: data.email,
        full_name: data.full_name,
        role: (data.role as UserRole) || "bu_user",
        entity_scope: Array.isArray(data.entity_scope) ? data.entity_scope : [],
      });
    } else {
      // 未有 profile (trigger 未跑 / 新 user) — set null, UI 會 prompt
      setProfile(null);
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      if (s?.user) fetchProfile(s.user.id);
      setLoading(false);
    });

    // 記住上一個 user id—若 auth state 換咗人（或 SIGNED_OUT），要清 react-query cache，
    // 唔係嘅話 staleTime:Infinity 會令下一個 user 睇到上一個 user 嘅 claims/data。
    let prevUserId: string | null = null;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      const nextUserId = s?.user?.id ?? null;
      if (event === "SIGNED_OUT" || nextUserId !== prevUserId) {
        queryClient.clear();
      }
      prevUserId = nextUserId;
      if (s?.user) {
        fetchProfile(s.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signUp = async (email: string, password: string, displayName: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    return { error: error?.message ?? null };
  };

  // Magic Link login—用戶 input email，Supabase 送 OTP 連結到佢 inbox，
  // click 则 redirect 回 app + 自動 sign in。第一次使用等同 sign-up
  // (auth.users 自動生成，trigger handle_new_user 拍 role+scope)。
  const signInWithMagicLink = async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        emailRedirectTo: window.location.origin,
        // shouldCreateUser 預設 true—首次 user auto-create
      },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    // 清 react-query cache，避免下一個喺同一 browser login 嘅 user 睇到舊 user cached data。
    queryClient.clear();
    setSession(null);
    setProfile(null);
  };

  const isOwner = profile?.role === "owner";
  const isAdmin = profile?.role === "admin";
  const isSuperUser = isOwner || isAdmin;
  const isBuUser = profile?.role === "bu_user";

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        profile,
        isAdmin,
        isOwner,
        isSuperUser,
        isBuUser,
        entityScope: profile?.entity_scope ?? [],
        loading,
        signIn,
        signUp,
        signInWithMagicLink,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

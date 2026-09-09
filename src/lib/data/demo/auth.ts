/**
 * Demo-mode authentication. Cookie-based sessions against the local store.
 * Replaced entirely by Supabase Auth when credentials are configured.
 */
import { getDemoStore, hashPassword, verifyPassword } from "./store";
import { DataError } from "../types";

export const DEMO_SESSION_COOKIE = "fm_demo_session";

export interface DemoSession {
  userId: string;
  email: string;
}

export function demoSignIn(email: string, password: string): DemoSession {
  const { state } = getDemoStore();
  const user = state.authUsers.find((u) => u.email === email.toLowerCase());
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new DataError("Incorrect email or password", "forbidden");
  }
  return { userId: user.id, email: user.email };
}

export function demoSignUp(input: {
  email: string;
  password: string;
  username: string;
  displayName: string;
}): DemoSession {
  const { state, persist } = getDemoStore();
  if (state.authUsers.some((u) => u.email === input.email)) {
    throw new DataError("An account with that email already exists", "conflict");
  }
  if (state.profiles.some((p) => p.username === input.username)) {
    throw new DataError("That username is taken", "conflict");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  state.authUsers.push({ id, email: input.email, passwordHash: hashPassword(input.password), createdAt: now });
  state.profiles.push({
    id,
    username: input.username,
    displayName: input.displayName,
    avatarUrl: null,
    bio: null,
    homeCity: null,
    createdAt: now,
    updatedAt: now,
  });
  persist();
  return { userId: id, email: input.email };
}

export function demoSessionFromCookie(value: string | undefined): DemoSession | null {
  if (!value) return null;
  const { state } = getDemoStore();
  const user = state.authUsers.find((u) => u.id === value);
  return user ? { userId: user.id, email: user.email } : null;
}

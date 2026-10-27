/**
 * Which account a phone's push token belongs to, across sign-in and sign-out.
 *
 * Signing in registers the token for that account (save_expo_push_token moves
 * it from whoever had it before). Signing out first deletes this device's row
 * from push_subscriptions while the session can still do so (RLS: users
 * remove their own devices), then unregisters the device from push locally,
 * so it stops receiving even when the server call failed (offline), and only
 * then ends the Supabase session. A registration still in flight is awaited
 * first, so it cannot re-add the token after it was removed.
 *
 * Pure TypeScript with the platform calls passed in (lib/push.ts wires them),
 * unit-tested in tests/mobile-push-lifecycle.test.ts.
 */

export interface PushLifecycleDeps {
  /** Permission (asking if needed) and the Expo token; null when push is not possible here. */
  obtainToken(): Promise<string | null>;
  /** The token this device registered, if any, without prompting. */
  currentToken(): Promise<string | null>;
  saveServerToken(token: string): Promise<void>;
  removeServerToken(token: string): Promise<void>;
  /** Stops this device receiving pushes until it registers again. */
  unregisterDevice(): Promise<void>;
  rememberToken(token: string): Promise<void>;
  forgetToken(): Promise<void>;
  /** Ends the Supabase session. */
  signOut(): Promise<void>;
}

export interface SignOutResult {
  /** False when the server row could not be deleted (it is cleaned up when the token is next used or reported gone). */
  serverRemoved: boolean;
  /** False when the device could not be unregistered locally. */
  deviceUnregistered: boolean;
}

export function createPushLifecycle(deps: PushLifecycleDeps) {
  let signingOut = false;
  let registering: Promise<string | null> | null = null;

  async function doRegister(): Promise<string | null> {
    const token = await deps.obtainToken();
    if (!token || signingOut) return null;
    await deps.saveServerToken(token);
    await deps.rememberToken(token);
    return token;
  }

  return {
    /** Registers this device for the signed-in account. Safe to call repeatedly. */
    register(): Promise<string | null> {
      if (signingOut) return Promise.resolve(null);
      registering ??= doRegister().finally(() => {
        registering = null;
      });
      return registering;
    },

    /** Removes this device's push token, then signs out. The sign-out always runs. */
    async signOut(): Promise<SignOutResult> {
      signingOut = true;
      try {
        await registering?.catch(() => null);
        let serverRemoved = true;
        let deviceUnregistered = true;
        const token = await deps.currentToken().catch(() => null);
        if (token) {
          try {
            await deps.removeServerToken(token);
          } catch {
            serverRemoved = false;
          }
          try {
            await deps.unregisterDevice();
          } catch {
            deviceUnregistered = false;
          }
        }
        await deps.forgetToken().catch(() => {});
        await deps.signOut();
        return { serverRemoved, deviceUnregistered };
      } finally {
        signingOut = false;
      }
    },
  };
}

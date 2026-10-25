import { useEffect, useState } from "react";
import { ApiError, getMe, type User } from "./api/client";
import AuthScreen from "./components/AuthScreen";
import SessionRestoring from "./components/SessionRestoring";
import Workspace from "./components/Workspace";
import { clearStoredToken, getStoredToken } from "./lib/session";
import "./App.css";

// What the login screen should show when it next appears.
interface AuthScreenState {
  email: string;
  notice: string;
  error: string;
  // Changing the key remounts AuthScreen so it picks up the new values.
  key: number;
}

/**
 * The session root: restores a saved session, then shows either the login
 * screen or the signed-in workspace.
 */
function App() {
  const [user, setUser] = useState<User | null>(null);
  // A stored token is verified before choosing between login and workspace,
  // so a signed-in user does not see the login form flash on refresh.
  const [restoringSession, setRestoringSession] = useState(
    () => getStoredToken() !== null,
  );
  const [authScreen, setAuthScreen] = useState<AuthScreenState>({
    email: "",
    notice: "",
    error: "",
    key: 0,
  });

  // Restore the authenticated session after a page refresh.
  useEffect(() => {
    const token = getStoredToken();

    if (token === null) {
      return;
    }

    let cancelled = false;

    async function restoreSession(storedToken: string) {
      try {
        const authenticatedUser = await getMe(storedToken);

        if (!cancelled) {
          setUser(authenticatedUser);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }

        if (err instanceof ApiError && err.status === 401) {
          clearStoredToken();
          return;
        }

        setAuthScreen((current) => ({
          ...current,
          error:
            "Unable to verify your session. Check your connection and try again.",
        }));
      } finally {
        if (!cancelled) {
          setRestoringSession(false);
        }
      }
    }

    void restoreSession(token);

    return () => {
      cancelled = true;
    };
  }, []);

  function handleSignOut(reason?: string) {
    clearStoredToken();
    setAuthScreen((current) => ({
      // Keep the email after an expiry so signing back in is one step.
      email: reason && user ? user.email : "",
      notice: reason ?? "",
      error: "",
      key: current.key + 1,
    }));
    setUser(null);
  }

  if (restoringSession) {
    return <SessionRestoring />;
  }

  if (user) {
    return <Workspace key={user.id} user={user} onSignOut={handleSignOut} />;
  }

  return (
    <AuthScreen
      key={authScreen.key}
      initialEmail={authScreen.email}
      initialNotice={authScreen.notice}
      initialError={authScreen.error}
      onSignedIn={setUser}
    />
  );
}

export default App;

import { useState, type FormEvent } from "react";
import { ApiError, getMe, login, register, type User } from "../api/client";
import { storeToken } from "../lib/session";

type AuthMode = "login" | "register";

interface AuthScreenProps {
  // Prefilled after an involuntary sign-out so signing back in is one step.
  initialEmail: string;
  initialNotice: string;
  initialError: string;
  onSignedIn: (user: User) => void;
}

function AuthScreen({
  initialEmail,
  initialNotice,
  initialError,
  onSignedIn,
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState(initialNotice);
  const [loading, setLoading] = useState(false);

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
    setNotice("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);

    try {
      if (mode === "register") {
        await register(email.trim(), password);
        setMode("login");
        setPassword("");
        setNotice("Account created. Please sign in.");
        return;
      }

      const tokenResponse = await login(email.trim(), password);
      const authenticatedUser = await getMe(tokenResponse.access_token);

      storeToken(tokenResponse.access_token);
      onSignedIn(authenticatedUser);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Unable to connect to the server. Check that the backend is running.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">C</div>
          <span className="brand-name">Curibot</span>
        </div>

        <div className="auth-heading">
          <h1>{mode === "login" ? "Welcome back" : "Create your account"}</h1>

          <p>
            {mode === "login"
              ? "Sign in to continue to your AI workspace."
              : "Create an account to get started."}
          </p>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={mode === "login" ? "auth-tab active" : "auth-tab"}
            onClick={() => switchMode("login")}
          >
            Sign in
          </button>

          <button
            type="button"
            className={mode === "register" ? "auth-tab active" : "auth-tab"}
            onClick={() => switchMode("register")}
          >
            Register
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email address</label>

          <input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="password">Password</label>

          <input
            id="password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={
              mode === "register" ? "At least 12 characters" : "Enter your password"
            }
            minLength={mode === "register" ? 12 : 1}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />

          {error && (
            <p className="auth-message auth-error" role="alert">
              {error}
            </p>
          )}

          {notice && (
            <p className="auth-message auth-success" role="status">
              {notice}
            </p>
          )}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading
              ? "Please wait..."
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <p className="auth-footnote">
          Your conversations are saved privately to your account.
        </p>
      </section>
    </main>
  );
}

export default AuthScreen;

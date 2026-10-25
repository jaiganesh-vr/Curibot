// Shown while a stored token is verified, so a signed-in user does not see
// the login form flash on refresh.
function SessionRestoring() {
  return (
    <main className="auth-page">
      <div className="session-restoring" role="status">
        <div className="brand-mark" aria-hidden="true">
          C
        </div>
        <p>Restoring your session…</p>
      </div>
    </main>
  );
}

export default SessionRestoring;

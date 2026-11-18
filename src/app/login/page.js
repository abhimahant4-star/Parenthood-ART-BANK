"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Icon } from "@/components/ui";
import { apiRequest } from "@/lib/api";

export default function LoginPage() {
  const { user, ready, signIn } = useSession();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ready && user) router.replace("/dashboard");
  }, [ready, user, router]);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const credentials = { username: username.trim(), password };
    try {
      let result;
      try {
        result = await apiRequest("/auth/login", { method: "POST", body: credentials });
      } catch (loginError) {
        if (loginError.status !== 409 || loginError.code !== "ACTIVE_SESSION" || !window.confirm(`${loginError.message}\n\nReplace the active hospital session?`)) throw loginError;
        result = await apiRequest("/auth/login", { method: "POST", body: { ...credentials, confirmReplaceSession: true } });
      }
      signIn(result.data.token, result.data.user);
      router.replace("/dashboard");
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-brand-panel" aria-label="Parenthood ART Bank">
        <div className="login-brand-copy">
          <span className="login-brand-eyebrow"><Icon name="shield-check" /> Parenthood ART Bank</span>
          <h1>Care workflows,<br /><em>clearly connected.</em></h1>
          <p>Donor records, vial inventory and hospital coordination in one secure workspace.</p>
          <div className="login-feature-pills">
            <span><Icon name="people" /> Donor records</span>
            <span><Icon name="droplet-half" /> Vial traceability</span>
            <span><Icon name="hospital" /> Hospital workflows</span>
          </div>
        </div>
      </section>
      <section className="login-form-wrap" aria-label="Sign in">
        <div className="login-card">
          <div className="login-card-kicker"><Icon name="lock" /> Secure workspace</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="login-logo" src="/assets/images/parenthood-art-bank-logo1.png" alt="Parenthood ART Bank" />
          <h2>Welcome back</h2>
          <p className="login-intro">Sign in with your provisioned account to continue.</p>
          <form onSubmit={submit}>
            <div className="login-field">
              <label className="form-label" htmlFor="loginUser">Login ID</label>
              <input className="form-control" id="loginUser" autoComplete="username" placeholder="Enter your login ID" required value={username} onChange={event => setUsername(event.target.value)} />
            </div>
            <div className="login-field">
              <label className="form-label" htmlFor="loginPass">Password</label>
              <div className="login-password-wrap">
                <input className="form-control" id="loginPass" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Enter your password" required value={password} onChange={event => setPassword(event.target.value)} />
                <button className="login-password-toggle" type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>
                  <Icon name={showPassword ? "eye-slash" : "eye"} />
                </button>
              </div>
            </div>
            <div aria-live="polite">{error && <div className="alert alert-danger">{error}</div>}</div>
            <button className="btn btn-primary login-submit" disabled={busy}>
              {busy ? "Signing in..." : <><span>Sign in</span><Icon name="arrow-right" /></>}
            </button>
          </form>
          <div className="login-card-footer">Authorized access only</div>
        </div>
      </section>
    </main>
  );
}

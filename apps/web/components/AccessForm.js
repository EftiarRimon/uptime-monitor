/* global FormData */
import { useState } from "react";

export default function AccessForm({ onSubmit, busy, error, notice }) {
  const [mode, setMode] = useState("login");
  function submit(event) {
    event.preventDefault();
    onSubmit(mode, Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <main className="auth">
      <section>
        <div className="logo">
          PULSE<span>OPS</span>
        </div>
        <p className="eyebrow">Uptime intelligence</p>
        <h1>Know when your services need you.</h1>
        <p className="lead">
          Monitor every endpoint, understand incidents, and keep your customers
          informed.
        </p>
      </section>
      <form className="card login" onSubmit={submit} aria-busy={busy}>
        <div className="mobile-brand logo">
          PULSE<span>OPS</span>
        </div>
        <p className="eyebrow">Workspace access</p>
        <h2>{mode === "login" ? "Welcome back" : "Create your workspace"}</h2>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <fieldset disabled={busy}>
          {mode === "register" && (
            <>
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  required
                  placeholder="Alex Morgan"
                />
              </label>
              <label>
                Workspace name
                <input
                  name="workspaceName"
                  autoComplete="organization"
                  required
                  placeholder="Acme Engineering"
                />
              </label>
            </>
          )}
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@company.com"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              minLength={8}
              required
              placeholder="At least 8 characters"
            />
          </label>
          <button>
            {busy
              ? mode === "login"
                ? "Signing in..."
                : "Creating workspace..."
              : mode === "login"
                ? "Sign in to dashboard"
                : "Create workspace"}
          </button>
          <p className="hint">
            {mode === "login" ? "New here? " : "Already have an account? "}
            <button
              type="button"
              className="inline-link"
              onClick={() => setMode(mode === "login" ? "register" : "login")}
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </fieldset>
      </form>
    </main>
  );
}

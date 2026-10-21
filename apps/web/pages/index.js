/* global localStorage, window, AbortController, setInterval, clearInterval */
import { useCallback, useEffect, useRef, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import AccessForm from "../components/AccessForm";
import MonitorForm from "../components/MonitorForm";
import {
  ApiError,
  request,
  refreshSession,
  forgetSession,
  login,
  logout,
  sameSession,
} from "../lib/api";

const blankForm = () => ({ name: "", url: "", intervalSeconds: 60 });
async function collection(path, key, token, signal) {
  const result = await request(path, { token, signal });
  if (!Array.isArray(result?.[key]))
    throw new ApiError(
      "The service returned an unexpected response. Try again.",
      502,
    );
  return result[key];
}

export default function Home() {
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState("");
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [authBusy, setAuthBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [authError, setAuthError] = useState("");
  const [notice, setNotice] = useState("");
  const [monitors, setMonitors] = useState(null);
  const [incidents, setIncidents] = useState(null);
  const [monitorError, setMonitorError] = useState("");
  const [incidentError, setIncidentError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [action, setAction] = useState(null);
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  const dashboardRequest = useRef(null);
  const mutationRequest = useRef(null);
  const token = session?.accessToken;

  const clearSession = useCallback((message = "") => {
    dashboardRequest.current?.abort();
    mutationRequest.current?.abort();
    forgetSession();
    setSession(null);
    setMonitors(null);
    setIncidents(null);
    setMonitorError("");
    setIncidentError("");
    setActionError("");
    setSuccess("");
    setEditingId(null);
    setForm(blankForm());
    setAction(null);
    setLastUpdated(null);
    setRefreshing(false);
    setRestoreError("");
    setAuthError("");
    setNotice(message);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const saved = localStorage.getItem("accessToken");
    setRestoring(true);
    setRestoreError("");
    if (!saved && !localStorage.getItem("pulseopsSession")) {
      setRestoring(false);
      return () => controller.abort();
    }
    const restore = async () => {
      const accessToken = saved || (await refreshSession()).accessToken;
      return request("/auth/me", {
        token: accessToken,
        signal: controller.signal,
      });
    };
    restore()
      .then((result) => {
        if (!controller.signal.aborted)
          setSession({
            ...result,
            accessToken: localStorage.getItem("accessToken"),
          });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error.status === 401)
          clearSession(
            "Your session has expired or workspace access changed. Sign in again.",
          );
        else setRestoreError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
  }, [restoreAttempt, clearSession]);

  useEffect(() => {
    const updated = (event) =>
      setSession((previous) =>
        previous && event.detail.user
          ? {
              ...previous,
              user: event.detail.user,
              workspace: event.detail.workspace,
              role: event.detail.role,
            }
          : previous,
      );
    const storageChanged = (event) => {
      if (event.key !== "accessToken") return;
      if (!event.newValue) clearSession();
      else if (event.oldValue && !sameSession(event.oldValue, event.newValue)) {
        dashboardRequest.current?.abort();
        mutationRequest.current?.abort();
        setMonitors(null);
        setIncidents(null);
        setSession(null);
        setRestoring(true);
        setRestoreAttempt((value) => value + 1);
      }
    };
    window.addEventListener("pulseops:session", updated);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener("pulseops:session", updated);
      window.removeEventListener("storage", storageChanged);
    };
  }, [clearSession]);

  async function signOut() {
    setSigningOut(true);
    try {
      await logout();
      clearSession();
    } catch (error) {
      if (session) setActionError(error.message);
      else setRestoreError(error.message);
    } finally {
      setSigningOut(false);
    }
  }

  const loadDashboard = useCallback(async () => {
    if (!token) return;
    dashboardRequest.current?.abort();
    const controller = new AbortController();
    dashboardRequest.current = controller;
    setRefreshing(true);
    const results = await Promise.allSettled([
      collection("/monitors", "monitors", token, controller.signal),
      collection("/incidents", "incidents", token, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    if (
      results.some(
        (result) =>
          result.status === "rejected" && result.reason.status === 401,
      )
    ) {
      clearSession("Your session has expired. Sign in again.");
      return;
    }
    if (results[0].status === "fulfilled") {
      setMonitors(results[0].value);
      setMonitorError("");
    } else setMonitorError(results[0].reason.message);
    if (results[1].status === "fulfilled") {
      setIncidents(results[1].value);
      setIncidentError("");
    } else setIncidentError(results[1].reason.message);
    if (results.every((result) => result.status === "fulfilled"))
      setLastUpdated(new Date());
    setRefreshing(false);
  }, [token, clearSession]);

  useEffect(() => {
    if (!token) return;
    setMonitors(null);
    setIncidents(null);
    setLastUpdated(null);
    loadDashboard();
    const timer = setInterval(loadDashboard, 30_000);
    return () => {
      clearInterval(timer);
      dashboardRequest.current?.abort();
      mutationRequest.current?.abort();
    };
  }, [token, loadDashboard]);

  async function authenticate(mode, values) {
    setAuthBusy(true);
    setAuthError("");
    setNotice("");
    try {
      const result = await login(mode, values);
      setSession(result);
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  function resetForm() {
    setEditingId(null);
    setForm(blankForm());
  }
  async function mutate(id, kind, path, method, body, message, reset = false) {
    const controller = new AbortController();
    mutationRequest.current = controller;
    setAction({ id, kind });
    setActionError("");
    setSuccess("");
    try {
      await request(path, { token, method, body, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (reset) resetForm();
      setSuccess(message);
      await loadDashboard();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error.status === 401)
        clearSession("Your session has expired. Sign in again.");
      else setActionError(error.message);
    } finally {
      if (!controller.signal.aborted) setAction(null);
    }
  }
  function save(event) {
    event.preventDefault();
    mutate(
      editingId,
      "save",
      editingId ? `/monitors/${editingId}` : "/monitors",
      editingId ? "PATCH" : "POST",
      form,
      editingId ? "Monitor updated." : "Monitor created.",
      true,
    );
  }
  function edit(monitor) {
    setEditingId(monitor.id);
    setForm({
      name: monitor.name,
      url: monitor.url,
      intervalSeconds: monitor.interval_seconds,
    });
    setActionError("");
    setSuccess("");
  }

  if (restoring || restoreError)
    return (
      <main className="session-screen">
        <Head>
          <title>Workspace access | PulseOps</title>
        </Head>
        <section className="card">
          <div className="logo">
            PULSE<span>OPS</span>
          </div>
          {restoring ? (
            <p role="status">Restoring your workspace...</p>
          ) : (
            <>
              <h1>Unable to load your workspace</h1>
              <p className="error" role="alert">
                {restoreError}
              </p>
              <p className="hint">
                Your session is saved. Retry when the service is available.
              </p>
              <button onClick={() => setRestoreAttempt((value) => value + 1)}>
                Retry workspace
              </button>
              <button
                className="check cancel-edit"
                disabled={signingOut}
                onClick={signOut}
              >
                {signingOut ? "Signing out..." : "Go to sign in"}
              </button>
            </>
          )}
        </section>
      </main>
    );
  if (!session)
    return (
      <>
        <Head>
          <title>Sign in | PulseOps</title>
        </Head>
        <AccessForm
          onSubmit={authenticate}
          busy={authBusy}
          error={authError}
          notice={notice}
        />
      </>
    );

  const canManage = session.role === "owner" || session.role === "admin";
  const busy = Boolean(action) || signingOut;
  const hasError = Boolean(monitorError || incidentError);
  const actionLabel = (monitor, kind, label, pending) =>
    action?.id === monitor.id && action.kind === kind ? pending : label;
  return (
    <main className="app">
      <Head>
        <title>Monitors | PulseOps</title>
      </Head>
      <header>
        <div className="logo">
          PULSE<span>OPS</span>
        </div>
        <div className="workspace">
          <span className="workspace-name">{session.workspace.name}</span>
          <span className="role-label">{session.role}</span>
          <button className="ghost" disabled={signingOut} onClick={signOut}>
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </header>
      <div className="content">
        <div className="topline dashboard-heading">
          <div>
            <p className="eyebrow">Operations</p>
            <h1>Monitors</h1>
            <p>Health across your services.</p>
          </div>
          <div className="refresh-controls">
            <span className={`live ${hasError ? "stale" : ""}`} role="status">
              {refreshing
                ? "Updating..."
                : hasError
                  ? "Some data unavailable"
                  : lastUpdated
                    ? `Updated ${lastUpdated.toLocaleTimeString()}`
                    : "Awaiting data"}
            </span>
            <button
              className="check"
              disabled={refreshing || busy}
              onClick={loadDashboard}
            >
              Refresh dashboard
            </button>
            <small>Auto-refresh every 30 seconds</small>
          </div>
        </div>
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
        {success && (
          <p className="success" role="status">
            {success}
          </p>
        )}
        {!canManage && (
          <p className="notice">
            You have viewer access. An owner or admin can add or change
            monitors.
          </p>
        )}
        <section className="stats" aria-label="Workspace summary">
          <div>
            <span>Total monitors</span>
            <strong>{monitors === null ? "-" : monitors.length}</strong>
          </div>
          <div>
            <span>Operational</span>
            <strong className="up">
              {monitors === null
                ? "-"
                : monitors.filter(
                    (monitor) =>
                      !monitor.is_paused && monitor.last_status === "up",
                  ).length}
            </strong>
          </div>
          <div>
            <span>Open incidents</span>
            <strong className="down">
              {incidents === null
                ? "-"
                : incidents.filter((incident) => incident.status === "open")
                    .length}
            </strong>
          </div>
        </section>
        <section className={`grid ${canManage ? "" : "viewer-grid"}`}>
          {canManage && (
            <MonitorForm
              form={form}
              setForm={setForm}
              editingId={editingId}
              busy={busy}
              saving={action?.kind === "save"}
              onSubmit={save}
              onCancel={resetForm}
            />
          )}
          <section className="card list" aria-labelledby="service-health">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Workspace monitors</p>
                <h2 id="service-health">Service health</h2>
              </div>
              <span>
                {monitors === null
                  ? "Loading"
                  : `${monitors.length} configured`}
              </span>
            </div>
            {monitorError && (
              <div className="error" role="alert">
                <p>
                  {monitorError}
                  {monitors !== null && " Showing last loaded monitors."}
                </p>
                <button
                  className="check"
                  disabled={refreshing}
                  onClick={loadDashboard}
                >
                  Retry monitors
                </button>
              </div>
            )}
            {monitors === null ? (
              !monitorError && (
                <div className="loading-state" role="status">
                  <p>Loading monitors...</p>
                  <div className="skeleton-row" aria-hidden="true" />
                  <div className="skeleton-row" aria-hidden="true" />
                </div>
              )
            ) : monitors.length === 0 ? (
              <div className="empty">
                <h3>No monitors yet</h3>
                <p>
                  {canManage
                    ? "Add your first endpoint to start collecting uptime data."
                    : "An owner or admin can add the first endpoint for this workspace."}
                </p>
              </div>
            ) : (
              monitors.map((monitor) => (
                <article className="monitor" key={monitor.id}>
                  <div
                    className={`status ${monitor.is_paused ? "paused" : monitor.last_status}`}
                    aria-hidden="true"
                  />
                  <div className="monitor-info">
                    <strong>
                      <Link
                        className="monitor-link"
                        href={`/monitors/${monitor.id}`}
                      >
                        {monitor.name}
                      </Link>
                    </strong>
                    <span title={monitor.url}>{monitor.url}</span>
                    <small>
                      {monitor.last_checked_at
                        ? `Last checked ${new Date(monitor.last_checked_at).toLocaleString()}`
                        : "Awaiting first check"}
                    </small>
                  </div>
                  <b
                    className={
                      monitor.is_paused ? "paused" : monitor.last_status
                    }
                  >
                    {monitor.is_paused ? "paused" : monitor.last_status}
                  </b>
                  {canManage && (
                    <div className="monitor-actions">
                      <button
                        className="check"
                        disabled={busy}
                        onClick={() => edit(monitor)}
                      >
                        Edit
                      </button>
                      <button
                        className="check"
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            monitor.id,
                            "pause",
                            `/monitors/${monitor.id}`,
                            "PATCH",
                            { isPaused: !monitor.is_paused },
                            monitor.is_paused
                              ? "Monitoring resumed."
                              : "Monitoring paused.",
                          )
                        }
                      >
                        {actionLabel(
                          monitor,
                          "pause",
                          monitor.is_paused ? "Resume" : "Pause",
                          monitor.is_paused ? "Resuming..." : "Pausing...",
                        )}
                      </button>
                      <button
                        className="check"
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            monitor.id,
                            "check",
                            `/monitors/${monitor.id}/check`,
                            "POST",
                            undefined,
                            "Monitor check completed.",
                          )
                        }
                      >
                        {actionLabel(monitor, "check", "Check", "Checking...")}
                      </button>
                      <button
                        className="delete"
                        aria-label={`Delete ${monitor.name}`}
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            monitor.id,
                            "delete",
                            `/monitors/${monitor.id}`,
                            "DELETE",
                            undefined,
                            "Monitor deleted.",
                            editingId === monitor.id,
                          )
                        }
                      >
                        {actionLabel(
                          monitor,
                          "delete",
                          "Delete",
                          "Deleting...",
                        )}
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
          </section>
        </section>
        <section className="card incidents" aria-labelledby="recent-incidents">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Reliability timeline</p>
              <h2 id="recent-incidents">Recent incidents</h2>
            </div>
            <span>
              {incidents === null ? "Loading" : `${incidents.length} total`}
            </span>
          </div>
          {incidentError && (
            <div className="error" role="alert">
              <p>
                {incidentError}
                {incidents !== null && " Showing last loaded incidents."}
              </p>
              <button
                className="check"
                disabled={refreshing}
                onClick={loadDashboard}
              >
                Retry incidents
              </button>
            </div>
          )}
          {incidents === null ? (
            !incidentError && (
              <p className="loading-state" role="status">
                Loading incidents...
              </p>
            )
          ) : incidents.length === 0 ? (
            <p className="empty">No incidents recorded in this workspace.</p>
          ) : (
            incidents.map((incident) => (
              <article className="incident" key={incident.id}>
                <span
                  className={`incident-dot ${incident.status}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>
                    {incident.title} |{" "}
                    <Link href={`/monitors/${incident.monitor_id}`}>
                      {incident.monitor_name}
                    </Link>
                  </strong>
                  <p>{incident.error_message}</p>
                  <small>
                    {new Date(incident.started_at).toLocaleString()} |{" "}
                    {incident.status}
                  </small>
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}

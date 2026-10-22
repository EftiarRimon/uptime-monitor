/* global AbortController */
import { useEffect, useState } from "react";
import Head from "next/head";
import { request } from "../../lib/api";

export default function PublicStatus({ slug }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    request(`/status/${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((reason) => {
        if (reason.name !== "AbortError") setError(reason.message);
      });
    return () => controller.abort();
  }, [slug]);

  if (error)
    return (
      <main className="status-page">
        <section className="card">
          <h1>Status page unavailable</h1>
          <p className="error">{error}</p>
        </section>
      </main>
    );
  if (!data)
    return (
      <main className="status-page">
        <section className="card">
          <p role="status">Loading status...</p>
        </section>
      </main>
    );

  const healthy = data.status === "operational";
  return (
    <main className="status-page">
      <Head>
        <title>{data.workspace.name} status | PulseOps</title>
      </Head>
      <header className="status-header">
        <div className="logo">
          PULSE<span>OPS</span>
        </div>
        <small>Public status</small>
      </header>
      <section className={`status-banner ${healthy ? "healthy" : "degraded"}`}>
        <span className="status-banner-dot" aria-hidden="true" />
        <div>
          <p className="eyebrow">{data.workspace.name}</p>
          <h1>
            {healthy
              ? "All systems operational"
              : data.status === "pending"
                ? "Monitoring is starting"
                : "Some systems are degraded"}
          </h1>
          <p>Live service health and incident updates.</p>
        </div>
      </section>
      <section className="card status-section" aria-labelledby="components">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Components</p>
            <h2 id="components">Service health</h2>
          </div>
          <span>{data.monitors.length} services</span>
        </div>
        {data.monitors.length === 0 ? (
          <p className="empty">No public services are configured yet.</p>
        ) : (
          data.monitors.map((monitor) => (
            <article className="status-component" key={monitor.id}>
              <span
                className={`status ${monitor.last_status}`}
                aria-hidden="true"
              />
              <strong>{monitor.name}</strong>
              <span className={monitor.last_status}>
                {monitor.last_status || "pending"}
              </span>
            </article>
          ))
        )}
      </section>
      <section className="card status-section" aria-labelledby="incidents">
        <div className="section-heading">
          <div>
            <p className="eyebrow">History</p>
            <h2 id="incidents">Recent incidents</h2>
          </div>
        </div>
        {data.incidents.length === 0 ? (
          <p className="empty">No incidents reported.</p>
        ) : (
          data.incidents.map((incident) => (
            <article className="incident" key={incident.id}>
              <span
                className={`incident-dot ${incident.status}`}
                aria-hidden="true"
              />
              <div>
                <strong>{incident.title}</strong>
                <p>{incident.error_message || "Service health event"}</p>
                <small>
                  {new Date(incident.started_at).toLocaleString()} ·{" "}
                  {incident.status}
                </small>
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}

export function getServerSideProps({ params }) {
  return { props: { slug: params.slug } };
}

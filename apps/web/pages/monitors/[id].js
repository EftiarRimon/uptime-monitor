/* global localStorage, AbortController */
import { useEffect, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import HistoryChart from "../../components/HistoryChart";
import { request, refreshSession } from "../../lib/api";

const timestamp = (value) => new Date(value).toLocaleString();
const percent = (value) =>
  value === null ? "No data" : `${value.toFixed(2)}%`;
const latency = (value) =>
  value === null ? "No data" : `${Math.round(value)} ms`;

export default function MonitorDetail() {
  const router = useRouter();
  const [hours, setHours] = useState(24);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const id = router.query.id;

  useEffect(() => {
    if (!router.isReady || typeof id !== "string") return;
    const saved = localStorage.getItem("accessToken");
    if (!saved && !localStorage.getItem("pulseopsSession")) {
      router.replace("/");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError("");
    async function load() {
      try {
        const token = saved || (await refreshSession()).accessToken;
        const result = await request(
          `/monitors/${encodeURIComponent(id)}?hours=${hours}`,
          { token, signal: controller.signal },
        );
        if (!controller.signal.aborted) setData(result);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error.status === 401
              ? "Your session has expired. Sign in again from the dashboard."
              : error.message || "Unable to reach the API",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [id, hours, refresh, router.isReady]);

  return (
    <main className="app">
      <Head>
        <title>
          {data
            ? `${data.monitor.name} | PulseOps`
            : "Monitor history | PulseOps"}
        </title>
      </Head>
      <header>
        <div className="logo">
          PULSE<span>OPS</span>
        </div>
        <Link href="/" className="back-link">
          Back to monitors
        </Link>
      </header>
      <div className="content monitor-detail">
        <div className="topline detail-heading">
          <div>
            <p className="eyebrow">Monitor history</p>
            <h1>{data?.monitor.name || "Service history"}</h1>
            {data && <p className="detail-url">{data.monitor.url}</p>}
          </div>
          <div className="history-controls">
            <label>
              Period
              <select
                value={hours}
                onChange={(event) => setHours(Number(event.target.value))}
              >
                <option value={24}>Last 24 hours</option>
                <option value={168}>Last 7 days</option>
                <option value={720}>Last 30 days</option>
              </select>
            </label>
            <button
              className="check"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              Refresh
            </button>
          </div>
        </div>
        {loading && (
          <p className="card" role="status">
            Loading monitor history...
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            <p>{error}</p>
            <button
              className="check"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Try again
            </button>{" "}
            <Link href="/">Go to dashboard</Link>
          </div>
        )}
        {data && (
          <>
            <p className="hint">
              {data.monitor.is_paused
                ? "Monitoring paused"
                : `Current status: ${data.monitor.last_status}`}{" "}
              | Interval: {data.monitor.interval_seconds} seconds |{" "}
              {data.monitor.last_checked_at
                ? `Last checked ${timestamp(data.monitor.last_checked_at)}`
                : "Awaiting first check"}
            </p>
            <section className="stats">
              <div>
                <span>Uptime by successful checks</span>
                <strong>{percent(data.summary.uptimePercent)}</strong>
              </div>
              <div>
                <span>Average successful response</span>
                <strong>{latency(data.summary.avgLatencyMs)}</strong>
              </div>
              <div>
                <span>Checks in period</span>
                <strong>{data.summary.totalChecks}</strong>
                <small>{data.summary.failedChecks} failed</small>
              </div>
            </section>
            <p className="hint">
              {timestamp(data.period.startsAt)} to{" "}
              {timestamp(data.period.endsAt)}. Times are local. Uptime is the
              percentage of recorded checks that succeeded; periods without
              checks are excluded. Latency includes successful checks only.
            </p>
            <div className="history-charts">
              <HistoryChart
                series={data.series}
                metric="uptimePercent"
                title="Uptime per time bucket"
                unit="%"
                ceiling={100}
              />
              <HistoryChart
                series={data.series}
                metric="avgLatencyMs"
                title="Average response latency"
                unit="ms"
              />
            </div>
            <details className="card bucket-table">
              <summary>
                View chart data ({data.period.bucketSeconds / 3600}-hour
                buckets)
              </summary>
              <div className="table-scroll">
                <table>
                  <caption>Aggregated checks for the selected period</caption>
                  <thead>
                    <tr>
                      <th>Bucket start</th>
                      <th>Checks</th>
                      <th>Uptime</th>
                      <th>Successful latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.series.map((bucket) => (
                      <tr key={bucket.bucketStart}>
                        <td>{timestamp(bucket.bucketStart)}</td>
                        <td>{bucket.totalChecks}</td>
                        <td>{percent(bucket.uptimePercent)}</td>
                        <td>{latency(bucket.avgLatencyMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <section className="card history-section">
              <h2>Recent checks</h2>
              <p className="hint">
                Latest 50 checks within the selected period.
              </p>
              {data.checks.length === 0 ? (
                <p className="empty">No checks recorded in this period.</p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <caption className="sr-only">Recent monitor checks</caption>
                    <thead>
                      <tr>
                        <th>Checked at</th>
                        <th>Status</th>
                        <th>HTTP</th>
                        <th>Duration</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.checks.map((check) => (
                        <tr key={check.id}>
                          <td>{timestamp(check.checked_at)}</td>
                          <td className={check.status}>{check.status}</td>
                          <td>{check.status_code ?? "-"}</td>
                          <td>
                            {check.response_time_ms === null
                              ? "-"
                              : `${check.response_time_ms} ms`}
                          </td>
                          <td>{check.error_message || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="card incidents">
              <h2>Incident timeline</h2>
              <p className="hint">
                Latest 50 incidents overlapping the selected period, including
                ongoing incidents.
              </p>
              {data.incidents.length === 0 ? (
                <p className="empty">No incidents in this period.</p>
              ) : (
                data.incidents.map((incident) => (
                  <article className="incident" key={incident.id}>
                    <span className={`incident-dot ${incident.status}`} />
                    <div>
                      <strong>{incident.title}</strong>
                      <p>{incident.error_message}</p>
                      <small>
                        Started {timestamp(incident.started_at)} |{" "}
                        {incident.resolved_at
                          ? `Resolved ${timestamp(incident.resolved_at)}`
                          : "Ongoing"}
                      </small>
                    </div>
                    <b className={incident.status === "open" ? "down" : "up"}>
                      {incident.status}
                    </b>
                  </article>
                ))
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

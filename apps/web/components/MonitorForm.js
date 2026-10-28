import { useEffect, useRef } from "react";

const TYPES = {
  http: {
    label: "HTTP(S) endpoint",
    placeholder: "https://api.example.com/health",
  },
  tcp: { label: "TCP port", placeholder: "tcp://db.example.com:5432" },
  ping: { label: "Ping (port 443)", placeholder: "ping://example.com" },
  heartbeat: { label: "Heartbeat (cron job)", placeholder: "" },
};

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
const heartbeatUrl = (name) => `heartbeat://${slug(name) || "monitor"}`;

export default function MonitorForm({
  form,
  setForm,
  editingId,
  busy,
  saving,
  onSubmit,
  onCancel,
}) {
  const nameInput = useRef(null);
  useEffect(() => {
    if (editingId) nameInput.current?.focus();
  }, [editingId]);
  const type = form.monitorType ?? "http";
  const isHeartbeat = type === "heartbeat";

  function changeName(name) {
    setForm({
      ...form,
      name,
      ...(isHeartbeat ? { url: heartbeatUrl(name) } : {}),
    });
  }
  function changeType(next) {
    let url = form.url;
    if (next === "heartbeat") url = heartbeatUrl(form.name);
    else if (isHeartbeat) url = "";
    setForm({ ...form, monitorType: next, url });
  }

  return (
    <form className="card create" onSubmit={onSubmit} aria-busy={saving}>
      <p className="eyebrow">{editingId ? "Edit monitor" : "New monitor"}</p>
      <h2>{editingId ? "Update monitor" : "Track a service"}</h2>
      <fieldset disabled={busy}>
        <label>
          Monitor type
          <select
            value={type}
            disabled={Boolean(editingId)}
            onChange={(e) => changeType(e.target.value)}
          >
            {Object.entries(TYPES).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            ref={nameInput}
            value={form.name}
            onChange={(event) => changeName(event.target.value)}
            placeholder={isHeartbeat ? "Nightly backup" : "Production API"}
            required
          />
        </label>
        {!isHeartbeat && (
          <label>
            URL
            <input
              type={type === "http" ? "url" : "text"}
              value={form.url}
              onChange={(event) =>
                setForm({ ...form, url: event.target.value })
              }
              placeholder={TYPES[type].placeholder}
              required
            />
          </label>
        )}
        <label>
          Interval (seconds)
          <input
            type="number"
            min={30}
            max={2147483647}
            step={1}
            required
            value={form.intervalSeconds}
            onChange={(event) =>
              setForm({ ...form, intervalSeconds: Number(event.target.value) })
            }
          />
        </label>
        {isHeartbeat && (
          <p className="hint">
            Your job calls a unique ping URL on every run. It is shown on the
            monitor after you create it. A monitor is marked down if no ping
            arrives within the interval plus a 60-second grace period.
          </p>
        )}
        <button>
          {saving ? "Saving..." : editingId ? "Save changes" : "Add monitor"}
        </button>
        {editingId && (
          <button
            type="button"
            className="check cancel-edit"
            onClick={onCancel}
          >
            Cancel editing
          </button>
        )}
      </fieldset>
    </form>
  );
}

import { useEffect, useState } from "react";
import { request } from "../lib/api";

export default function NotificationSettings({ token, canManage }) {
  const [channels, setChannels] = useState([]);
  const [form, setForm] = useState({ name: "", type: "webhook", target: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      setChannels(
        (await request("/notifications/channels", { token })).channels,
      );
    } catch (reason) {
      setError(reason.message);
    }
  }
  useEffect(() => {
    if (canManage) load();
  }, [canManage, token]);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/notifications/channels", {
        token,
        method: "POST",
        body: form,
      });
      setForm({ name: "", type: "webhook", target: "" });
      await load();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id) {
    setBusy(true);
    try {
      await request(`/notifications/channels/${id}`, {
        token,
        method: "DELETE",
      });
      await load();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }
  if (!canManage) return null;
  return (
    <section className="card status-settings">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Incident alerts</p>
          <h2>Notification channels</h2>
        </div>
        <span>{channels.length} channels</span>
      </div>
      <form onSubmit={save}>
        <label>
          Name
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
        </label>
        <label>
          Type
          <select
            value={form.type}
            onChange={(event) => setForm({ ...form, type: event.target.value })}
          >
            <option value="webhook">Webhook</option>
            <option value="email">Email</option>
            <option value="slack">Slack</option>
          </select>
        </label>
        <label>
          Target
          <input
            value={form.target}
            onChange={(event) =>
              setForm({ ...form, target: event.target.value })
            }
            placeholder={
              form.type === "email"
                ? "alerts@example.com"
                : "https://hooks.example.com/..."
            }
            required
          />
        </label>
        <button disabled={busy}>{busy ? "Saving..." : "Add channel"}</button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {channels.map((channel) => (
        <div className="api-key-row" key={channel.id}>
          <span>
            <strong>{channel.name}</strong>
            <small>
              {channel.type} · {channel.is_enabled ? "enabled" : "disabled"}
            </small>
          </span>
          <button
            className="delete"
            disabled={busy}
            onClick={() => remove(channel.id)}
          >
            Delete
          </button>
        </div>
      ))}
    </section>
  );
}

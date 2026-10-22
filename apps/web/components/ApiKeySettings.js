import { useEffect, useState } from "react";
import { request } from "../lib/api";

export default function ApiKeySettings({ token, canManage }) {
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      const result = await request("/api-keys", { token });
      setKeys(result.keys);
    } catch (reason) {
      setError(reason.message);
    }
  }
  useEffect(() => {
    if (canManage) load();
  }, [canManage, token]);
  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await request("/api-keys", {
        token,
        method: "POST",
        body: { name },
      });
      setName("");
      setNewKey(result.key);
      await load();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id) {
    setBusy(true);
    try {
      await request(`/api-keys/${id}`, { token, method: "DELETE" });
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
          <p className="eyebrow">Developer access</p>
          <h2>API keys</h2>
        </div>
        <span>{keys.length} keys</span>
      </div>
      <form onSubmit={create}>
        <label>
          Key name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Production integration"
            required
          />
        </label>
        <button disabled={busy}>
          {busy ? "Working..." : "Create API key"}
        </button>
      </form>
      {newKey && (
        <p className="success" role="status">
          Copy this key now: <code>{newKey}</code>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {keys.map((key) => (
        <div className="api-key-row" key={key.id}>
          <span>
            <strong>{key.name}</strong>
            <small>
              {key.key_prefix} · {key.revoked_at ? "revoked" : "active"}
            </small>
          </span>
          {!key.revoked_at && (
            <button
              className="delete"
              disabled={busy}
              onClick={() => revoke(key.id)}
            >
              Revoke
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

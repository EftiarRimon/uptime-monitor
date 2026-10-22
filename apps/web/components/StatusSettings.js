import { useEffect, useState } from "react";
import { request } from "../lib/api";

export default function StatusSettings({ token, canManage }) {
  const [settings, setSettings] = useState(null);
  const [slug, setSlug] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    request("/status/settings", { token })
      .then((result) => {
        const value = result.settings;
        setSettings(value);
        setSlug(value.status_slug || value.slug || "");
        setIsPublic(value.status_public);
      })
      .catch((reason) => setError(reason.message));
  }, [token]);
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await request("/status/settings", {
        token,
        method: "PATCH",
        body: { slug, isPublic },
      });
      setSettings(result.settings);
      setMessage("Status page settings saved.");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSaving(false);
    }
  }
  if (!settings || !canManage) return null;
  return (
    <section className="card status-settings">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Public status</p>
          <h2>Status page</h2>
        </div>
        <span>{isPublic ? "Published" : "Private"}</span>
      </div>
      <form onSubmit={save}>
        <label>
          Public slug
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
          />
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(event) => setIsPublic(event.target.checked)}
          />{" "}
          Publish this status page
        </label>
        <button disabled={saving}>
          {saving ? "Saving..." : "Save settings"}
        </button>
      </form>
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {isPublic && (
        <p className="hint">
          Public URL: <code>/status/{slug}</code>
        </p>
      )}
    </section>
  );
}

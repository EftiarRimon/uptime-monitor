import { useEffect, useRef } from "react";

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
  return (
    <form className="card create" onSubmit={onSubmit} aria-busy={saving}>
      <p className="eyebrow">{editingId ? "Edit monitor" : "New monitor"}</p>
      <h2>{editingId ? "Update endpoint" : "Track an endpoint"}</h2>
      <fieldset disabled={busy}>
        <label>
          Name
          <input
            ref={nameInput}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Production API"
            required
          />
        </label>
        <label>
          URL
          <input
            type="url"
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
            placeholder="https://api.example.com/health"
            required
          />
        </label>
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

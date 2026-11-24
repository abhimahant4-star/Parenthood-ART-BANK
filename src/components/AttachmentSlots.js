"use client";

export const newSlots = (count = 2) => Array.from({ length: count }, (_, index) => ({ id: index, label: "", file: null, custom: false }));

const CREATE_NEW = "__create_new__";

// Label picker: a fixed list of types plus "Create new item", which switches to a text box.
function TypePicker({ slot, typeOptions, update }) {
  if (slot.custom) {
    return (
      <div className="input-group">
        <input className="form-control" id={`slotLabel-${slot.id}`} maxLength={120} placeholder="New document type" autoFocus value={slot.label} onChange={event => update(slot.id, { label: event.target.value })} />
        <button className="btn btn-outline-secondary" type="button" title="Back to the list" onClick={() => update(slot.id, { custom: false, label: "" })}>List</button>
      </div>
    );
  }
  return (
    <select className="form-select" id={`slotLabel-${slot.id}`} value={slot.label} onChange={event => update(slot.id, event.target.value === CREATE_NEW ? { custom: true, label: "" } : { label: event.target.value })}>
      <option value="">Select document type</option>
      {typeOptions.map(name => <option key={name} value={name}>{name}</option>)}
      <option value={CREATE_NEW}>+ Create new item…</option>
    </select>
  );
}

// Repeating label + file inputs used for document packages (up to five files).
export function AttachmentSlots({ slots, setSlots, labelTitle = "File label", placeholder = "e.g. Screening report", typeOptions }) {
  const update = (id, patch) => setSlots(current => current.map(slot => (slot.id === id ? { ...slot, ...patch } : slot)));
  return slots.map(slot => (
    <div className="row g-2 align-items-end attachment-slot border rounded p-2 mb-2" key={slot.id}>
      <div className="col-md-5">
        <label className="form-label" htmlFor={`slotLabel-${slot.id}`}>{labelTitle}</label>
        {typeOptions
          ? <TypePicker slot={slot} typeOptions={typeOptions} update={update} />
          : <input className="form-control" id={`slotLabel-${slot.id}`} placeholder={placeholder} value={slot.label} onChange={event => update(slot.id, { label: event.target.value })} />}
      </div>
      <div className="col-md-7">
        <label className="form-label" htmlFor={`slotFile-${slot.id}`}>PDF, JPG or PNG (max 10 MB)</label>
        <input className="form-control" id={`slotFile-${slot.id}`} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={event => update(slot.id, { file: event.target.files[0] || null })} />
      </div>
    </div>
  ));
}

export function addSlot(slots, setSlots, onLimit) {
  if (slots.length >= 5) return onLimit("A package can contain up to 5 files.");
  return setSlots(current => [...current, { id: Math.max(...current.map(slot => slot.id)) + 1, label: "", file: null, custom: false }]);
}

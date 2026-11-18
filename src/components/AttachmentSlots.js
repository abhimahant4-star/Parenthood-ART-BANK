"use client";

export const newSlots = (count = 2) => Array.from({ length: count }, (_, index) => ({ id: index, label: "", file: null }));

// Repeating label + file inputs used for document packages (up to five files).
export function AttachmentSlots({ slots, setSlots, labelTitle = "File label", placeholder = "e.g. Screening report" }) {
  const update = (id, patch) => setSlots(current => current.map(slot => (slot.id === id ? { ...slot, ...patch } : slot)));
  return slots.map(slot => (
    <div className="row g-2 align-items-end attachment-slot border rounded p-2 mb-2" key={slot.id}>
      <div className="col-md-5">
        <label className="form-label" htmlFor={`slotLabel-${slot.id}`}>{labelTitle}</label>
        <input className="form-control" id={`slotLabel-${slot.id}`} placeholder={placeholder} value={slot.label} onChange={event => update(slot.id, { label: event.target.value })} />
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
  return setSlots(current => [...current, { id: Math.max(...current.map(slot => slot.id)) + 1, label: "", file: null }]);
}

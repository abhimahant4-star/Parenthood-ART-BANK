"use client";

// Super Admin edit and delete controls shared by the Donors, Batches, Vials and Dashboard pages.
import { useState } from "react";
import { useSession } from "./SessionProvider";
import { Alert, Field, Icon, Modal } from "./ui";
import { apiRequest } from "@/lib/api";
import { BLOOD_GROUPS, DONOR_TRAIT_OPTIONS } from "@/lib/format";

export function useIsSuperAdmin() {
  const { user } = useSession();
  return user?.role === "SUPER_ADMIN";
}

const STOCK_CHOICES = [{ value: "NORMAL_STOCK", label: "Normal stock" }, { value: "KARYOTYPE_TESTED", label: "Karyotype tested" }];
const enc = value => encodeURIComponent(value);

export function RecordActions({ onEdit, onDelete, label }) {
  return (
    <span className="record-actions">
      {onEdit && <button type="button" className="record-action-btn" title={`Edit ${label}`} aria-label={`Edit ${label}`} onClick={onEdit}><Icon name="pencil-square" /></button>}
      {onDelete && <button type="button" className="record-action-btn danger" title={`Delete ${label}`} aria-label={`Delete ${label}`} onClick={onDelete}><Icon name="trash3" /></button>}
    </span>
  );
}

function SaveFooter({ formId, saving, onClose, label = "Save changes" }) {
  return (
    <>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form={formId} disabled={saving}>{saving ? "Saving…" : label}</button>
    </>
  );
}

function useSave(onSaved) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const run = async request => {
    setSaving(true);
    setError("");
    try {
      const result = await request();
      onSaved(result?.data);
    } catch (saveError) {
      setError(saveError.message);
      setSaving(false);
    }
  };
  return { saving, error, run };
}

// Deletion needs the record's ID typed back, so one stray click never removes data.
export function DeleteRecordModal({ kind, id, path, consequence, onClose, onDeleted }) {
  const [typed, setTyped] = useState("");
  const { saving, error, run } = useSave(onDeleted);
  const matches = typed.trim().toUpperCase() === String(id).toUpperCase();
  const submit = event => {
    event.preventDefault();
    if (matches) run(() => apiRequest(path, { method: "DELETE" }));
  };
  return (
    <Modal title={`Delete ${kind}`} onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" form="deleteRecordForm" disabled={!matches || saving}>{saving ? "Deleting…" : `Delete ${kind}`}</button>
    </>}>
      <Alert message={error} />
      <div className="alert alert-danger d-flex gap-2"><Icon name="exclamation-triangle-fill" /><div><strong>This cannot be undone.</strong> {consequence} The deletion is recorded in the audit trail.</div></div>
      <form id="deleteRecordForm" onSubmit={submit}>
        <label className="form-label" htmlFor="deleteConfirm">Type <code>{id}</code> to confirm</label>
        <input id="deleteConfirm" className="form-control nl-trace-input-light" autoComplete="off" value={typed} onChange={event => setTyped(event.target.value)} autoFocus />
      </form>
    </Modal>
  );
}

export function EditVialModal({ vial, onClose, onSaved }) {
  const [form, setForm] = useState({ stockClassification: vial.stockClassification || "NORMAL_STOCK" });
  const { saving, error, run } = useSave(onSaved);
  const submit = event => {
    event.preventDefault();
    run(() => apiRequest(`/vials/${enc(vial.vialId)}`, { method: "PUT", body: form }));
  };
  return (
    <Modal title={`Edit vial ${vial.vialId}`} onClose={onClose} footer={<SaveFooter formId="editVialForm" saving={saving} onClose={onClose} />}>
      <Alert message={error} />
      <form id="editVialForm" className="row g-3" onSubmit={submit}>
        <Field form={form} setForm={setForm} label="Stock type" name="stockClassification" col="col-12" choices={STOCK_CHOICES} />
      </form>
      <p className="small text-secondary mt-3 mb-0">Status changes such as block and recall stay on the Vials page. Location and custody change only through dispatch and receipt.</p>
    </Modal>
  );
}

export function EditBatchModal({ batch, onClose, onSaved }) {
  const quarantined = batch.releaseStatus === "QUARANTINED";
  const originalDate = batch.collectionAt ? String(batch.collectionAt).slice(0, 10) : "";
  const [form, setForm] = useState({ stockClassification: batch.stockClassification || "NORMAL_STOCK", notes: batch.notes || "", collectionAt: originalDate });
  const { saving, error, run } = useSave(onSaved);
  const submit = event => {
    event.preventDefault();
    const body = { stockClassification: form.stockClassification, notes: form.notes };
    if (quarantined && form.collectionAt && form.collectionAt !== originalDate) body.collectionAt = form.collectionAt;
    run(() => apiRequest(`/batches/${enc(batch.batchId)}`, { method: "PUT", body }));
  };
  return (
    <Modal title={`Edit batch ${batch.batchId}`} onClose={onClose} footer={<SaveFooter formId="editBatchForm" saving={saving} onClose={onClose} />}>
      <Alert message={error} />
      <form id="editBatchForm" className="row g-3" onSubmit={submit}>
        <Field form={form} setForm={setForm} label="Stock type" name="stockClassification" choices={STOCK_CHOICES} hint="Vials still at the ART Bank are updated too." />
        <Field form={form} setForm={setForm} label="Collection date" name="collectionAt" type="date" disabled={!quarantined} hint={quarantined ? "Quarantine end moves to six months after this date." : "Locked after release."} />
        <div className="col-12">
          <label className="form-label" htmlFor="batchNotes">Notes</label>
          <textarea id="batchNotes" className="form-control" rows={3} maxLength={1000} value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} />
        </div>
      </form>
    </Modal>
  );
}

export function EditDonorModal({ donor, onClose, onSaved }) {
  const original = {
    name: donor.name || "", manualDonorId: donor.manualDonorId || "", maritalStatus: donor.maritalStatus || "", dob: donor.dob ? String(donor.dob).slice(0, 10) : "",
    bloodGroup: donor.bloodGroup || "", status: donor.status || "Active", height: donor.height || "", complexion: donor.complexion || "",
    eyeColour: donor.eyeColour || "", hairColour: donor.hairColour || "", build: donor.build || ""
  };
  const [form, setForm] = useState({ ...original, aadhaar: "" });
  const { saving, error, run } = useSave(onSaved);
  const hasCollections = (donor.trace?.batchIds?.length || 0) > 0 || (donor.trace?.vialTotal || 0) > 0;
  const traitChoices = (label, values) => [{ value: "", label: `Not recorded` }, ...values.map(value => ({ value, label: value }))];
  const submit = event => {
    event.preventDefault();
    // Only changed fields are sent.
    const body = Object.fromEntries(Object.entries(original).filter(([key, value]) => form[key] !== value).map(([key]) => [key, typeof form[key] === "string" ? form[key].trim() : form[key]]));
    if (form.aadhaar) body.aadhaar = form.aadhaar;
    if (!Object.keys(body).length) return onClose();
    run(() => apiRequest(`/donors/${enc(donor.donorId)}`, { method: "PUT", body }));
  };
  const fieldProps = { form, setForm };
  return (
    <Modal title={`Edit donor ${donor.uhid || donor.donorId}`} onClose={onClose} footer={<SaveFooter formId="editDonorForm" saving={saving} onClose={onClose} />}>
      <Alert message={error} />
      <form id="editDonorForm" className="row g-3" onSubmit={submit}>
        <Field {...fieldProps} label="Full legal name" name="name" required />
        <Field {...fieldProps} label="Manual donor ID" name="manualDonorId" required maxLength={50} />
        <Field {...fieldProps} label="Marital status" name="maritalStatus" required choices={[{ value: "MARRIED", label: "Married" }, { value: "UNMARRIED", label: "Unmarried" }]} />
        <Field {...fieldProps} label="Date of birth" name="dob" type="date" required />
        <Field {...fieldProps} label="Blood group" name="bloodGroup" required disabled={hasCollections} choices={BLOOD_GROUPS} hint={hasCollections ? "Locked because batch and vial IDs include the blood group." : undefined} />
        <Field {...fieldProps} label="Donor status" name="status" choices={["Active", "Inactive", "Retired"]} />
        <Field {...fieldProps} label="New Aadhaar number (optional)" name="aadhaar" placeholder="Leave blank to keep the current one" pattern="[0-9]{12}" maxLength={12} inputMode="numeric" autoComplete="off" onValue={value => value.replace(/\D/g, "").slice(0, 12)} hint={`Current: ${donor.aadhaarMasked || "not recorded"}`} />
        <Field {...fieldProps} label="Height" name="height" placeholder="e.g. 5.8 ft" />
        <Field {...fieldProps} label="Skin tone" name="complexion" choices={traitChoices("skin tone", DONOR_TRAIT_OPTIONS.complexion)} />
        <Field {...fieldProps} label="Eye colour" name="eyeColour" choices={traitChoices("eye colour", DONOR_TRAIT_OPTIONS.eyeColour)} />
        <Field {...fieldProps} label="Hair colour" name="hairColour" choices={traitChoices("hair colour", DONOR_TRAIT_OPTIONS.hairColour)} />
        <Field {...fieldProps} label="Build" name="build" choices={traitChoices("build", DONOR_TRAIT_OPTIONS.build)} />
      </form>
    </Modal>
  );
}

// Holds which edit/delete window is open, so each page needs only one line to render them.
export function useRecordModals(onChanged) {
  const [modal, setModal] = useState(null);
  const close = () => setModal(null);
  const done = () => { setModal(null); onChanged?.(); };
  const element = !modal ? null
    : modal.type === "editVial" ? <EditVialModal vial={modal.record} onClose={close} onSaved={done} />
    : modal.type === "editBatch" ? <EditBatchModal batch={modal.record} onClose={close} onSaved={done} />
    : modal.type === "editDonor" ? <EditDonorModal donor={modal.record} onClose={close} onSaved={done} />
    : modal.type === "deleteVial" ? <DeleteRecordModal kind="vial" id={modal.record.vialId} path={`/vials/${enc(modal.record.vialId)}`} consequence="The vial is removed and its batch's vial count goes down by one. Vials that have been sent to a hospital cannot be deleted." onClose={close} onDeleted={done} />
    : modal.type === "deleteBatch" ? <DeleteRecordModal kind="batch" id={modal.record.batchId} path={`/batches/${enc(modal.record.batchId)}`} consequence="The batch and all of its vials are removed. This is only allowed while none of its vials has left the ART Bank." onClose={close} onDeleted={done} />
    : modal.type === "deleteDonor" ? <DeleteRecordModal kind="donor" id={modal.record.uhid || modal.record.donorId} path={`/donors/${enc(modal.record.donorId)}`} consequence="The donor record and their private Aadhaar and document files are removed. A donor with batches or vials must have those deleted first." onClose={close} onDeleted={done} />
    : null;
  return { open: (type, record) => setModal({ type, record }), element };
}

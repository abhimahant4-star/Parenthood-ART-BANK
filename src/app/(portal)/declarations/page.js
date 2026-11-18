"use client";

import { useRef, useState } from "react";
import { AttachmentSlots, addSlot, newSlots } from "@/components/AttachmentSlots";
import { DeclarationPreviewModal } from "@/components/DeclarationPaper";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, DataTable, Field, Icon, LoadErrors, LoadMore, Modal, PageTitle, useLoader, usePagedList } from "@/components/ui";
import { apiRequest, loadAll } from "@/lib/api";
import { canOperateBank, localDateTime, todayIso, validUploadFile } from "@/lib/format";

const DEFAULT_STATEMENT = "I confirm the approved patient, donor and mapped vial information are correct.";
const extractRecords = result => result.data?.records || [];

function linkedDonor(couple, vials, donors) {
  const ids = new Set((couple?.mappedVialIds || []).map(id => vials.find(vial => vial.vialId === id)?.donorId).filter(Boolean));
  return ids.size === 1 ? donors.find(donor => donor.donorId === [...ids][0]) || null : null;
}

function coupleDefaults(couple, vials, donors, current = {}) {
  const mask = linkedDonor(couple, vials, donors)?.aadhaarMasked || "";
  return {
    patientName: current.patientName || couple?.wife?.name || couple?.husband?.name || "",
    registrationId: current.registrationId || couple?.coupleId || "",
    first: mask.length >= 12 ? mask.slice(0, 2) : "",
    last: mask.length >= 12 ? mask.slice(-2) : ""
  };
}

function NewDeclarationModal({ couples, vials, donors, signers, onClose, onSaved }) {
  const today = todayIso();
  const activeSigners = signers.filter(signer => signer.status === "ACTIVE");
  const [form, setForm] = useState(() => ({
    coupleId: couples[0].coupleId, patientAge: "", patientSex: "", referral: "", date: today, sampleDate: today, sampleId: "",
    signerId: activeSigners[0]?.signerId || "", statement: DEFAULT_STATEMENT, ...coupleDefaults(couples[0], vials, donors)
  }));
  const [slots, setSlots] = useState(newSlots(1));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState("");
  const [preview, setPreview] = useState(null);
  const formRef = useRef(null);

  const couple = couples.find(item => item.coupleId === form.coupleId);
  const donor = linkedDonor(couple, vials, donors);
  const maskLocked = (donor?.aadhaarMasked || "").length >= 12;

  const chooseCouple = value => {
    const selected = couples.find(item => item.coupleId === value);
    setForm(current => ({ ...current, ...coupleDefaults(selected, vials, donors, current) }));
    return value;
  };
  const digits = value => value.replace(/\D/g, "").slice(0, 2);

  const buildData = () => ({
    date: form.date, sampleDate: form.sampleDate, patientName: form.patientName.trim(),
    patientAge: form.patientAge !== "" ? Number(form.patientAge) : "", patientSex: form.patientSex,
    referral: form.referral.trim(), registrationId: form.registrationId.trim(), sampleId: form.sampleId.trim(),
    vials: couple.mappedVialIds, donor: donor?.donorId, aadhaarMasked: `${form.first}••••••••${form.last}`,
    signerId: form.signerId, statement: form.statement
  });

  const showPreview = () => {
    if (!formRef.current.reportValidity()) return;
    if (!/^\d{2}$/.test(form.first) || !/^\d{2}$/.test(form.last)) return setError("Enter exactly two digits at each end. Never enter the full Aadhaar number.");
    setError("");
    setPreview({
      declaration: { declarationId: "PREVIEW", coupleId: couple.coupleId, hospitalId: couple.hospitalId, centreId: couple.centreId, vialIds: couple.mappedVialIds, declarationData: { ...buildData(), aadhaarMasked: donor?.aadhaarMasked || "", sampleId: form.sampleId || "Preview sample ID" } },
      couple, donor, signer: signers.find(item => item.signerId === form.signerId)
    });
  };

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    if (savedId) return setError("This declaration was already saved. Do not submit it again; upload the supporting documents from the Documents page.");
    setError("");
    if (!/^\d{2}$/.test(form.first) || !/^\d{2}$/.test(form.last)) return setError("Enter exactly two Aadhaar digits at each end.");
    if (!couple?.mappedVialIds?.length || !donor) return setError("A declaration needs mapped vials from one donor.");
    const chosen = slots.filter(slot => slot.file);
    if (chosen.some(slot => !validUploadFile(slot.file))) return setError("Each supporting document must be PDF, JPG or PNG and no larger than 10 MB.");
    setSaving(true);
    try {
      const created = await apiRequest("/declarations", { method: "POST", body: { coupleId: couple.coupleId, declarationType: "ART_BANK", confirmations: { detailsVerified: true }, declarationData: buildData() } });
      if (chosen.length) {
        const formData = new FormData();
        formData.append("metadata", JSON.stringify({ hospitalId: "ART_BANK", centreId: "ART_BANK", relatedId: donor.donorId, category: "DONOR_DOCUMENT", label: `Declaration ${created.data.declarationId} supporting documents`, fileLabels: chosen.map(slot => slot.label.trim()) }));
        chosen.forEach(slot => formData.append("files", slot.file));
        try {
          await apiRequest("/attachments", { method: "POST", formData });
        } catch (uploadError) {
          setSavedId(created.data.declarationId);
          setSaving(false);
          return setError(`Declaration ${created.data.declarationId} was saved, but supporting document upload failed. Do not create the declaration again; upload the documents from the Documents page. ${uploadError.message}`);
        }
      }
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  const fieldProps = { form, setForm };
  return (
    <>
      <Modal title="Create declaration" className={preview ? "d-none" : ""} onClose={preview ? undefined : (savedId ? onSaved : onClose)} footer={<>
        <button className="btn btn-light" type="button" onClick={savedId ? onSaved : onClose}>Cancel</button>
        <button className="btn btn-outline-primary" type="button" onClick={showPreview}>Preview</button>
        <button className="btn btn-primary" form="declarationForm" disabled={saving || Boolean(savedId)}>{savedId ? "Declaration saved" : saving ? "Saving…" : "Save draft"}</button>
      </>}>
        <Alert message={error} />
        <form id="declarationForm" ref={formRef} className="row g-3" onSubmit={submit}>
          <Field {...fieldProps} label="Couple case" name="coupleId" required onValue={chooseCouple} choices={couples.map(item => ({ value: item.coupleId, label: `${item.coupleId} · ${item.hospitalId}` }))} />
          <div className="col-md-6"><label className="form-label" htmlFor="decDonorNumber">Donor Number</label><input id="decDonorNumber" className="form-control" readOnly placeholder="Set from the selected couple's mapped donor" value={donor ? donor.manualDonorId || donor.uhid || donor.donorId : ""} /></div>
          <div className="col-12 alert alert-light border mb-0">{donor ? `Linked donor: ${donor.uhid || donor.donorId} · ${donor.name} · ${donor.aadhaarMasked || "Aadhaar mask unavailable for this existing record"}` : "Linked donor details are unavailable. Confirm the couple has mapped vials from one donor."}</div>
          <Field {...fieldProps} label="Patient name" name="patientName" required />
          <Field {...fieldProps} label="Patient age (years)" name="patientAge" type="number" required min={0} max={120} step={1} />
          <Field {...fieldProps} label="Patient sex" name="patientSex" choices={[{ value: "", label: "Select sex" }, "Female", "Male", "Other"]} />
          <Field {...fieldProps} label="Referral" name="referral" />
          <Field {...fieldProps} label="Registration ID" name="registrationId" required />
          <Field {...fieldProps} label="Report date" name="date" type="date" required />
          <Field {...fieldProps} label="Sample date" name="sampleDate" type="date" required />
          <Field {...fieldProps} label="Sample ID" name="sampleId" />
          <Field {...fieldProps} label="Donor Aadhaar first two digits" name="first" required placeholder="00" maxLength={2} inputMode="numeric" readOnly={maskLocked} onValue={digits} />
          <Field {...fieldProps} label="Donor Aadhaar last two digits" name="last" required placeholder="00" maxLength={2} inputMode="numeric" readOnly={maskLocked} onValue={digits} />
          <Field {...fieldProps} label="Authorised signatory" name="signerId" required choices={activeSigners.length ? activeSigners.map(signer => ({ value: signer.signerId, label: `${signer.name} · ${signer.designation} · v${signer.version}` })) : [{ value: "", label: "No active signatory available" }]} />
          <div className="col-12">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <strong>Donor documents (optional)</strong>
              <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => addSlot(slots, setSlots, () => setError("A declaration can contain up to 5 supporting documents."))}>Add document</button>
            </div>
            <AttachmentSlots slots={slots} setSlots={setSlots} labelTitle="Document label" placeholder="e.g. Blood report or affidavit" />
            <div className="form-text">Documents are saved against this declaration&apos;s donor ID and can be accessed from that donor&apos;s record.</div>
          </div>
          <div className="col-12">
            <label className="form-label" htmlFor="decStatement">Declaration statement</label>
            <textarea id="decStatement" className="form-control" rows={3} required value={form.statement} onChange={event => setForm(current => ({ ...current, statement: event.target.value }))} />
          </div>
        </form>
        <div className="alert alert-info mt-3 mb-0">Enter the patient&apos;s verified age in years and the actual sample collection date. The sample date starts as today and can be changed. The donor number is derived from the donor linked to the couple&apos;s mapped vials. Enter only the first two and last two Aadhaar digits.</div>
      </Modal>
      {preview && <DeclarationPreviewModal {...preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function ReportDetailsModal({ declaration, onClose, onSaved }) {
  const data = declaration.declarationData || {};
  const [form, setForm] = useState({ patientAge: data.patientAge ?? "", sampleDate: data.sampleDate || "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await apiRequest(`/declarations/${encodeURIComponent(declaration.declarationId)}/draft-report-details`, { method: "PATCH", body: { patientAge: Number(form.patientAge), sampleDate: form.sampleDate } });
      onSaved();
    } catch (saveError) { setError(saveError.message || "Could not save declaration report details."); setSaving(false); }
  };
  return (
    <Modal title="Complete declaration report details" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="reportDetailsForm" disabled={saving}>{saving ? "Saving…" : "Save details"}</button>
    </>}>
      <Alert message={error} />
      <form id="reportDetailsForm" className="row g-3" onSubmit={submit}>
        <Field form={form} setForm={setForm} label="Patient age (years)" name="patientAge" type="number" required min={0} max={120} step={1} />
        <Field form={form} setForm={setForm} label="Sample date" name="sampleDate" type="date" required />
      </form>
      <div className="alert alert-info mt-3 mb-0">Enter the verified patient age and actual sample collection date. These details will be saved to this draft report; they are not inferred from donor information.</div>
    </Modal>
  );
}

function CorrectionRequestModal({ declaration, revisionOf, onClose, onSaved }) {
  const data = declaration.declarationData || {};
  const prior = Object.fromEntries((revisionOf?.proposedChanges || []).map(change => [change.field, change.value]));
  const [form, setForm] = useState({ date: prior.date ?? data.date ?? "", statement: prior.statement ?? data.statement ?? "", reason: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    const proposedChanges = [];
    if (form.date && form.date !== data.date) proposedChanges.push({ field: "date", value: form.date });
    if (form.statement.trim() && form.statement !== data.statement) proposedChanges.push({ field: "statement", value: form.statement });
    if (!proposedChanges.length) return setError("Change the report date or statement before submitting a correction.");
    setSaving(true);
    const id = encodeURIComponent(declaration.declarationId);
    const path = revisionOf ? `/declarations/${id}/correction-requests/${encodeURIComponent(revisionOf.requestId)}/resubmit` : `/declarations/${id}/correction-requests`;
    try {
      await apiRequest(path, { method: "POST", body: { baseVersion: declaration.currentVersion || 1, reason: form.reason.trim(), proposedChanges } });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  return (
    <Modal title={revisionOf ? "Revise correction request" : "Request declaration correction"} onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="correctionForm" disabled={saving}>{saving ? "Saving…" : "Submit for review"}</button>
    </>}>
      <Alert message={error} />
      {revisionOf?.reviewReason && <div className="alert alert-warning">Reviewer note: {revisionOf.reviewReason}</div>}
      <form id="correctionForm" className="row g-3" onSubmit={submit}>
        <Field form={form} setForm={setForm} label="Report date" name="date" type="date" />
        <div className="col-12"><label className="form-label" htmlFor="correctionStatement">Declaration statement</label><textarea id="correctionStatement" className="form-control" rows={3} value={form.statement} onChange={event => setForm(current => ({ ...current, statement: event.target.value }))} /></div>
        <div className="col-12"><label className="form-label" htmlFor="correctionReason">Reason for correction</label><textarea id="correctionReason" className="form-control" rows={2} required value={form.reason} onChange={event => setForm(current => ({ ...current, reason: event.target.value }))} /></div>
      </form>
      <p className="small text-secondary mt-3 mb-0">Only the report date and statement can be corrected. ART Bank reviews every request before a new declaration version is created.</p>
    </Modal>
  );
}

function ReviewCorrectionModal({ request, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const act = async (action, body) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await apiRequest(`/correction-requests/${encodeURIComponent(request.requestId)}/${action}`, { method: "POST", body });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };
  const reject = () => (reason.trim() ? act("reject", { reason: reason.trim() }) : setError("Enter a reason before requesting a revision."));

  return (
    <Modal title="Review correction request" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-outline-danger" type="button" disabled={saving} onClick={reject}>Request revision</button>
      <button className="btn btn-primary" type="button" disabled={saving} onClick={() => act("approve", {})}>Approve correction</button>
    </>}>
      <Alert message={error} />
      <div className="row g-3 mb-3">
        <div className="col-sm-6"><div className="detail-label">Declaration</div><div className="detail-value">{request.declarationId}</div></div>
        <div className="col-sm-6"><div className="detail-label">Requested by</div><div className="detail-value">{request.requestedBy} · {localDateTime(request.requestedAt)}</div></div>
        <div className="col-12"><div className="detail-label">Reason</div><div className="detail-value">{request.reason}</div></div>
        {(request.proposedChanges || []).map(change => <div className="col-12" key={change.field}><div className="detail-label">Proposed {change.field}</div><div className="detail-value">{change.value}</div></div>)}
      </div>
      <label className="form-label" htmlFor="reviewReason">Revision note (required to request a revision)</label>
      <textarea id="reviewReason" className="form-control" rows={2} value={reason} onChange={event => setReason(event.target.value)} />
    </Modal>
  );
}

export default function DeclarationsPage() {
  const { user } = useSession();
  const hospital = user.role === "HOSPITAL_USER", bank = canOperateBank(user);
  const canReview = ["SUPER_ADMIN", "ART_BANK_ADMIN"].includes(user.role);
  const list = usePagedList("/declarations");
  const corrections = usePagedList(hospital || canReview ? "/correction-requests" : "/declarations", {}, hospital || canReview ? extractRecords : () => []);
  const related = useLoader(() => loadAll({ couples: "/couples?limit=500", vials: "/vials?limit=500", donors: bank ? "/donors?limit=500" : null, signers: bank ? "/signers?limit=500" : null }), [bank]);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(null);

  const results = related.data?.results || {};
  const couples = results.couples?.data || [], vials = results.vials?.data || [], donors = results.donors?.data || [], signers = results.signers?.data || [];
  const unavailable = Boolean(related.data?.errors?.length) || related.loading;
  const requests = hospital || canReview ? corrections.records : [];

  const finish = () => { setModal(null); list.reload(); corrections.reload(); related.reload(); };
  const startNew = () => {
    setMessage(null);
    const mapped = couples.filter(couple => couple.mappedVialIds?.length);
    if (!mapped.length) return setMessage({ type: "warning", text: "Map at least one vial to a couple before creating a declaration." });
    setModal({ type: "new", couples: mapped });
  };
  const preview = declaration => {
    const couple = couples.find(item => item.coupleId === declaration.coupleId);
    const donor = donors.find(item => item.donorId === declaration.declarationData?.donor);
    const signer = declaration.signerSnapshot || signers.find(item => item.signerId === declaration.signerId);
    setModal({ type: "preview", paper: { declaration, couple, donor, signer } });
  };
  const runAction = async (action, declaration) => {
    setMessage(null);
    const id = encodeURIComponent(declaration.declarationId);
    if (action === "preview") return preview(declaration);
    if (action === "details") return setModal({ type: "details", declaration });
    if (action === "request") return setModal({ type: "request", declaration });
    if (action === "correct") {
      const pending = requests.find(item => item.declarationId === declaration.declarationId && item.status === "PENDING_REVIEW");
      if (pending && canReview) return setModal({ type: "review", request: pending });
      return setMessage({ type: "danger", text: "Declaration changes require a hospital correction request and bank review." });
    }
    if (action === "unsubmit" && !window.confirm("Unsubmit this declaration? The hospital will no longer be able to view it.")) return undefined;
    try {
      await apiRequest(`/declarations/${id}/${action}`, { method: "POST", body: {} });
      list.reload();
    } catch (error) { setMessage({ type: "danger", text: error.message }); }
    return undefined;
  };

  return (
    <>
      <PageTitle title={hospital ? "Submitted declarations" : "Declarations"} subtitle={hospital ? "Only declarations submitted to your centre are visible" : "Fixed-format declarations, preview and version history"} action={bank && (
        <button className="btn btn-primary" type="button" disabled={unavailable} title={unavailable ? "Retry loading declaration data before creating a declaration" : undefined} onClick={startNew}><Icon name="plus-lg" className="me-1" />Create declaration</button>
      )} />
      <Alert message={message?.text} type={message?.type} onClose={() => setMessage(null)} />
      <Alert message={list.error} />
      <LoadErrors errors={related.data?.errors} />
      <div className="section-card declaration-list-card">
        <DataTable headers={["Declaration", "Donor ID", "Hospital", "Vials", "Version", "Status", "Action"]} empty={list.loading ? "Loading declarations…" : list.error ? "Declaration records could not be loaded. Retry before treating this list as empty." : "No declarations yet"}>
          {list.records.map(declaration => {
            const data = declaration.declarationData || {};
            const missingDetails = data.patientAge === undefined || data.patientAge === null || data.patientAge === "" || !data.sampleDate;
            const options = [
              ["preview", "Preview"],
              ...(bank && declaration.status === "DRAFT" && missingDetails ? [["details", "Add age / date"]] : []),
              ...(bank && ["DRAFT", "SUBMITTED"].includes(declaration.status) ? [["correct", "Correct"]] : []),
              ...(bank && declaration.status === "DRAFT" ? [["submit", "Submit"]] : []),
              ...(bank && declaration.status === "SUBMITTED" ? [["unsubmit", "Unsubmit"]] : []),
              ...(hospital && declaration.status === "SUBMITTED" && !declaration.pendingCorrectionRequestId ? [["request", "Request correction"]] : [])
            ];
            return (
              <tr key={declaration.declarationId}>
                <td>{declaration.declarationId}</td>
                <td>{data.donorNumber || data.donorUhid || data.donor || ""}</td>
                <td>{declaration.hospitalId}</td>
                <td>{(declaration.vialIds || data.vials || []).join(", ")}</td>
                <td>v{declaration.currentVersion || 1}</td>
                <td><Badge status={declaration.status} /></td>
                <td>
                  <select className="form-select form-select-sm declaration-action-select" aria-label={`Actions for declaration ${declaration.declarationId}`} value="" onChange={event => runAction(event.target.value, declaration)}>
                    <option value="">Select action</option>
                    {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </td>
              </tr>
            );
          })}
        </DataTable>
        <LoadMore list={list} label="declarations" />
      </div>
      {(hospital || canReview) && (
        <div className="section-card mt-4">
          <div className="card-head"><strong>Correction requests</strong></div>
          <Alert message={corrections.error} />
          <DataTable headers={["Declaration", "Requested by", "Requested", "Reason", "Status", "Action"]} empty={corrections.loading ? "Loading correction requests…" : "No correction requests"}>
            {requests.map(request => {
              const declaration = list.records.find(item => item.declarationId === request.declarationId);
              return (
                <tr key={request.requestId}>
                  <td>{request.declarationId}</td>
                  <td>{request.requestedBy}</td>
                  <td>{localDateTime(request.requestedAt)}</td>
                  <td>{request.reason}</td>
                  <td><Badge status={request.status} /></td>
                  <td>
                    {canReview && request.status === "PENDING_REVIEW" && <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setModal({ type: "review", request })}>Review</button>}
                    {hospital && request.status === "REVISION_REQUIRED" && declaration && !declaration.pendingCorrectionRequestId && <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setModal({ type: "request", declaration, revisionOf: request })}>Revise</button>}
                  </td>
                </tr>
              );
            })}
          </DataTable>
          <LoadMore list={corrections} label="correction requests" />
        </div>
      )}
      {modal?.type === "new" && <NewDeclarationModal couples={modal.couples} vials={vials} donors={donors} signers={signers} onClose={() => setModal(null)} onSaved={finish} />}
      {modal?.type === "preview" && <DeclarationPreviewModal {...modal.paper} onClose={() => setModal(null)} />}
      {modal?.type === "details" && <ReportDetailsModal declaration={modal.declaration} onClose={() => setModal(null)} onSaved={finish} />}
      {modal?.type === "request" && <CorrectionRequestModal declaration={modal.declaration} revisionOf={modal.revisionOf} onClose={() => setModal(null)} onSaved={finish} />}
      {modal?.type === "review" && <ReviewCorrectionModal request={modal.request} onClose={() => setModal(null)} onSaved={finish} />}
    </>
  );
}

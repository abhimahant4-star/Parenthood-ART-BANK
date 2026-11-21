"use client";

import { useEffect, useRef, useState } from "react";
import { AttachmentSlots, addSlot, newSlots } from "@/components/AttachmentSlots";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, DataTable, Field, Icon, IdTag, LoadMore, Modal, PageTitle, useLoader, usePagedList } from "@/components/ui";
import { apiRequest, downloadAttachment } from "@/lib/api";
import { canOperateBank, validUploadFile } from "@/lib/format";

async function uploadPackage(metadata, chosen) {
  const formData = new FormData();
  formData.append("metadata", JSON.stringify({ ...metadata, fileLabels: chosen.map(slot => slot.label.trim()) }));
  chosen.forEach(slot => formData.append("files", slot.file));
  await apiRequest("/attachments", { method: "POST", formData });
}

function checkSlots(slots) {
  const chosen = slots.filter(slot => slot.file);
  if (!chosen.length) throw new Error("Add at least one PDF, JPG or PNG file.");
  if (chosen.some(slot => !validUploadFile(slot.file))) throw new Error("Attachments must be PDF, JPG or PNG and no larger than 10 MB each.");
  return chosen;
}

function NewPackageModal({ hospitals, onClose, onSaved }) {
  const [form, setForm] = useState({ hospitalId: hospitals[0].hospitalId, centreId: hospitals[0].centres?.[0]?.centreId || "", relatedId: "", label: "" });
  const [slots, setSlots] = useState(newSlots());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const selected = hospitals.find(item => item.hospitalId === form.hospitalId);

  const chooseHospital = value => {
    const hospital = hospitals.find(item => item.hospitalId === value);
    setForm(current => ({ ...current, centreId: hospital?.centres?.[0]?.centreId || "" }));
    return value;
  };
  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      await uploadPackage({ hospitalId: form.hospitalId, centreId: form.centreId, relatedId: form.relatedId.trim(), category: "BANK_DOCUMENT", label: form.label.trim() }, checkSlots(slots));
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  const fieldProps = { form, setForm };
  return (
    <Modal title="New attachment package" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="attachmentForm" disabled={saving}>{saving ? "Saving…" : "Upload package"}</button>
    </>}>
      <Alert message={error} />
      <form id="attachmentForm" onSubmit={submit}>
        <div className="row g-3 mb-3">
          <Field {...fieldProps} label="Hospital" name="hospitalId" required onValue={chooseHospital} choices={hospitals.map(item => ({ value: item.hospitalId, label: item.hospitalName || item.name }))} />
          <Field {...fieldProps} label="Centre" name="centreId" required choices={(selected?.centres || []).map(item => ({ value: item.centreId, label: item.centreName || item.name }))} />
          <Field {...fieldProps} label="Related vial / case ID (optional)" name="relatedId" />
          <Field {...fieldProps} label="Package label" name="label" required />
        </div>
        <div className="d-flex justify-content-between align-items-center mb-2">
          <strong>Private attachments</strong>
          <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => addSlot(slots, setSlots, setError)}>Add file slot</button>
        </div>
        <AttachmentSlots slots={slots} setSlots={setSlots} />
        <p className="small text-secondary">Uploads are saved outside the public web directory. Hospital users can access only their own submitted packages.</p>
      </form>
    </Modal>
  );
}

function DonorDocumentsModal({ onClose, onSaved }) {
  const [search, setSearch] = useState("");
  const [donors, setDonors] = useState(null);
  const [donorHint, setDonorHint] = useState("Search for a donor first");
  const [donorId, setDonorId] = useState("");
  const [label, setLabel] = useState("");
  const [slots, setSlots] = useState(newSlots());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const version = useRef(0);

  useEffect(() => {
    const query = search.trim();
    const current = ++version.current;
    setDonorId("");
    setDonors(null);
    if (!query) { setDonorHint("Search for a donor first"); return undefined; }
    if (query.length < 2) { setDonorHint("Type at least 2 characters"); return undefined; }
    setDonorHint("Searching donors…");
    const timer = setTimeout(async () => {
      try {
        const records = (await apiRequest(`/donors?q=${encodeURIComponent(query)}&limit=100`)).data || [];
        if (current !== version.current) return;
        setDonors(records);
        setDonorHint(records.length ? "Select donor" : "No matching donors");
      } catch (searchError) {
        if (current === version.current) { setDonorHint("Could not load donors"); setError(searchError.message); }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      await uploadPackage({ hospitalId: "ART_BANK", centreId: "ART_BANK", relatedId: donorId, category: "DONOR_DOCUMENT", label: label.trim() }, checkSlots(slots));
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  return (
    <Modal title="Upload donor documents" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="attachmentForm" disabled={saving}>{saving ? "Saving…" : "Upload documents"}</button>
    </>}>
      <Alert message={error} />
      <form id="attachmentForm" className="row g-3" onSubmit={submit}>
        <div className="col-12">
          <label className="form-label" htmlFor="docDonorSearch">Search donor by number, UHID, or name</label>
          <input id="docDonorSearch" className="form-control" type="search" autoComplete="off" placeholder="Type at least 2 characters" required value={search} onChange={event => setSearch(event.target.value)} />
          <select className="form-select mt-2" aria-label="Donor" required value={donorId} onChange={event => setDonorId(event.target.value)}>
            <option value="">{donorHint}</option>
            {(donors || []).map(donor => <option key={donor.donorId} value={donor.donorId}>{donor.manualDonorId || donor.uhid || donor.donorId} · {donor.name}</option>)}
          </select>
        </div>
        <div className="col-12">
          <label className="form-label" htmlFor="docLabel">Package label</label>
          <input id="docLabel" className="form-control" maxLength={160} placeholder="Blood-related documents and supporting affidavits" required value={label} onChange={event => setLabel(event.target.value)} />
        </div>
        <div className="col-12">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <strong>Donor documents</strong>
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => addSlot(slots, setSlots, setError)}>Add file</button>
          </div>
          <AttachmentSlots slots={slots} setSlots={setSlots} labelTitle="Document label" placeholder="e.g. Blood screening report" />
        </div>
        <p className="small text-secondary mb-0">Files are privately stored, linked to the donor ID, and visible to a hospital only when that donor&apos;s vial has been sent to its centre.</p>
      </form>
    </Modal>
  );
}

function PackageId({ id }) {
  const [visible, setVisible] = useState(false);
  const text = String(id || "");
  const label = `${visible ? "Hide" : "Show"} full package ID`;
  return (
    <div className={`compact-id-cell document-package-id ${visible ? "is-visible" : ""}`}>
      <span className="compact-id-preview" title={text}>{text.length > 24 ? `${text.slice(0, 17)}...${text.slice(-4)}` : text}</span>
      <button className="compact-id-toggle" type="button" aria-label={label} aria-expanded={visible} title={label} onClick={() => setVisible(current => !current)}><Icon name={visible ? "eye-slash" : "eye"} /></button>
      <span className="compact-id-full" aria-live="polite">{text}</span>
    </div>
  );
}

export default function DocumentsPage() {
  const { user } = useSession();
  const hospital = user.role === "HOSPITAL_USER", bank = canOperateBank(user);
  const list = usePagedList("/attachments");
  const hospitals = useLoader(async () => (bank ? (await apiRequest("/hospitals")).data || [] : []), [bank]);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(null);

  const finish = () => { setModal(null); list.reload(); };
  const startPackage = () => {
    setMessage(null);
    if (!(hospitals.data || []).length) return setMessage({ type: "warning", text: "No hospital/centre assignments are configured yet." });
    setModal("package");
  };
  const toggle = async item => {
    setMessage(null);
    try {
      await apiRequest(`/attachments/${encodeURIComponent(item.attachmentId)}/visibility`, { method: "PATCH", body: { status: item.status === "SUBMITTED" ? "DRAFT" : "SUBMITTED" } });
      list.reload();
    } catch (error) { setMessage({ type: "danger", text: error.message }); }
  };

  return (
    <>
      <PageTitle title={hospital ? "My submitted documents" : "Documents"} subtitle={hospital ? "Your centre's files and donor documents for stock in your care" : "Private file storage with hospital-scoped visibility"} action={bank && <div>
        <button className="btn btn-outline-primary me-2" type="button" onClick={() => setModal("donor")}>Upload donor documents</button>
        <button className="btn btn-primary" type="button" onClick={startPackage}>New package</button>
      </div>} />
      <Alert message={message?.text} type={message?.type} onClose={() => setMessage(null)} />
      <Alert message={list.error} />
      <div className="section-card documents-list-card">
        <DataTable headers={["Package", "Label", "Hospital / centre / donor", "Files", "Visibility", "Action"]} empty={list.loading ? "Loading documents…" : "No records yet"}>
          {list.records.map(item => (
            <tr key={item.attachmentId}>
              <td><PackageId id={item.attachmentId} /></td>
              <td><div className="document-label">{item.label || item.category}</div></td>
              <td>{item.category === "DONOR_DOCUMENT" ? <span className="nl-donor-id"><Icon name="lock-fill" />{item.relatedId}</span> : <IdTag value={`${item.hospitalId} / ${item.centreId}`} icon="hospital" tone="slate" />}</td>
              <td>
                <div className="document-file-list">
                  {(item.files || []).length ? item.files.map(file => (
                    <button key={file.fileId} className="btn btn-sm document-file-link" type="button" title={`Download ${file.originalName}`} onClick={() => downloadAttachment(item.attachmentId, file.fileId, file.originalName).catch(error => setMessage({ type: "danger", text: error.message }))}>
                      <Icon name="download" /><span>{file.label || file.originalName}</span>
                    </button>
                  )) : "No files"}
                </div>
              </td>
              <td><Badge status={item.status} label={item.status === "SUBMITTED" ? "Submitted (hospital visible)" : item.status === "UNSUBMITTED" ? "Unsubmitted (bank only)" : undefined} /></td>
              <td>{bank && item.category !== "DONOR_DOCUMENT" && <button className={`btn btn-sm ${item.status === "SUBMITTED" ? "btn-outline-primary" : "btn-primary"}`} type="button" onClick={() => toggle(item)}>{item.status === "SUBMITTED" ? "Unsubmit" : "Submit to centre"}</button>}</td>
            </tr>
          ))}
        </DataTable>
        <LoadMore list={list} label="packages" />
      </div>
      {modal === "package" && <NewPackageModal hospitals={hospitals.data} onClose={() => setModal(null)} onSaved={finish} />}
      {modal === "donor" && <DonorDocumentsModal onClose={() => setModal(null)} onSaved={finish} />}
    </>
  );
}

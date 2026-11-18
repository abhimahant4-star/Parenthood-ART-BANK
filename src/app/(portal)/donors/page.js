"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, DataTable, Field, Icon, LoadMore, Modal, PageTitle, selectChoices, usePagedList } from "@/components/ui";
import { apiRequest, downloadAttachment } from "@/lib/api";
import { BLOOD_GROUPS, DONOR_TRAIT_OPTIONS, HEIGHT_QUICK_PICKS, ageFromDob, displayDob, localDate, normalizeBloodGroup, validUploadFile } from "@/lib/format";

const EMPTY_DONOR = { manualDonorId: "", name: "", maritalStatus: "", aadhaar: "", dob: "", bloodGroup: "", status: "Active", height: "", complexion: "", eyeColour: "", hairColour: "", build: "" };

function NewDonorModal({ onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY_DONOR);
  const [scan, setScan] = useState(null);
  const [error, setError] = useState("");
  const [busyLabel, setBusyLabel] = useState("");
  const [savedWithoutScan, setSavedWithoutScan] = useState(null);

  const submit = async event => {
    event.preventDefault();
    if (busyLabel) return;
    setError("");
    const age = ageFromDob(form.dob);
    if (!/^\d{12}$/.test(form.aadhaar)) return setError("Enter exactly 12 Aadhaar digits.");
    if (age === "" || age < 21 || age > 55) return setError("Donor age must be between 21 and 55 years.");
    if (scan && !validUploadFile(scan)) return setError("Aadhaar scan must be a PDF, JPG or PNG under 10 MB.");

    setBusyLabel("Checking…");
    try {
      const params = new URLSearchParams({ name: form.name.trim(), dob: form.dob, bloodGroup: form.bloodGroup.trim() });
      const duplicates = (await apiRequest(`/donors/possible-duplicates?${params}`)).data || {};
      if (duplicates.matches) {
        const examples = (duplicates.donors || []).map(donor => `${donor.uhid || donor.donorId} (${donor.name})`).join(", ");
        const extra = duplicates.truncated ? " More matches exist." : "";
        if (!window.confirm(`${duplicates.matches} possible donor match(es) found: ${examples}.${extra} Review existing records before deciding whether to continue.`)) {
          setBusyLabel("");
          return;
        }
      }
    } catch (duplicateError) {
      setBusyLabel("");
      return setError(`Could not check for a possible duplicate. ${duplicateError.message}`);
    }

    let created;
    setBusyLabel("Saving donor…");
    try {
      created = await apiRequest("/donors", { method: "POST", body: {
        name: form.name.trim(), manualDonorId: form.manualDonorId.trim(), maritalStatus: form.maritalStatus, aadhaar: form.aadhaar,
        dob: form.dob, bloodGroup: form.bloodGroup.trim(), status: form.status, height: form.height.trim(),
        complexion: form.complexion, eyeColour: form.eyeColour, hairColour: form.hairColour, build: form.build
      } });
    } catch (saveError) {
      setBusyLabel("");
      return setError(saveError.message);
    }

    // The donor now exists; clear sensitive Aadhaar input before the separate file request.
    setForm(current => ({ ...current, aadhaar: "" }));
    if (scan) {
      setBusyLabel("Uploading scan…");
      try {
        const formData = new FormData();
        formData.append("metadata", JSON.stringify({ hospitalId: "ART_BANK", centreId: "ART_BANK", relatedId: created.data.donorId, category: "DONOR_AADHAAR", label: `Aadhaar document for ${created.data.uhid}`, fileLabels: ["Aadhaar card"] }));
        formData.append("files", scan);
        await apiRequest("/attachments", { method: "POST", formData });
      } catch {
        setBusyLabel("");
        return setSavedWithoutScan(created.data.uhid || created.data.donorId);
      }
    }
    onSaved();
  };

  if (savedWithoutScan) {
    return (
      <Modal title="Register donor" onClose={onSaved}>
        <div className="alert alert-warning mb-3">Donor {savedWithoutScan} was saved, but the Aadhaar scan upload did not complete. Do not submit the donor again.</div>
        <p className="small text-secondary">Record the donor UHID and have an administrator attach the scan through the approved document process.</p>
        <button className="btn btn-primary" type="button" onClick={onSaved}>View donor list</button>
      </Modal>
    );
  }

  const fieldProps = { form, setForm };
  return (
    <Modal title="Register donor" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="newDonorForm" disabled={Boolean(busyLabel)}>{busyLabel || "Save donor"}</button>
    </>}>
      <Alert message={error} />
      <form id="newDonorForm" className="row g-3 donor-registration-form" onSubmit={submit}>
        <div className="col-12 donor-form-section"><span className="donor-section-number">01</span><h6>Donor identifiers</h6></div>
        <div className="col-md-6 donor-uhid-field"><label className="form-label">UHID</label><input className="form-control donor-uhid-preview" value="Generated when saved" readOnly /></div>
        <Field {...fieldProps} label="Manual donor ID" name="manualDonorId" required placeholder="e.g. D-105" maxLength={50} />
        <div className="col-12 donor-form-section"><span className="donor-section-number">02</span><h6>Demographics</h6></div>
        <Field {...fieldProps} label="Full legal name" name="name" required />
        <Field {...fieldProps} label="Marital status" name="maritalStatus" required choices={[{ value: "", label: "Select marital status" }, { value: "MARRIED", label: "Married" }, { value: "UNMARRIED", label: "Unmarried" }]} />
        <Field {...fieldProps} label="Aadhaar number" name="aadhaar" required placeholder="12 digits" pattern="[0-9]{12}" maxLength={12} inputMode="numeric" autoComplete="off" onValue={value => value.replace(/\D/g, "").slice(0, 12)} />
        <div className="col-md-6">
          <label className="form-label" htmlFor="donorScan">Aadhaar card scan <span className="text-secondary">(PDF, JPG or PNG)</span></label>
          <input id="donorScan" className="form-control" type="file" accept="application/pdf,image/png,image/jpeg" onChange={event => setScan(event.target.files[0] || null)} />
        </div>
        <Field {...fieldProps} label="Date of birth" name="dob" type="date" required />
        <div className="col-md-6"><label className="form-label">Calculated age</label><input className="form-control" placeholder="Eligible range: 21–55" value={ageFromDob(form.dob)} readOnly /></div>
        <Field {...fieldProps} label="Blood group" name="bloodGroup" required choices={selectChoices("blood group", BLOOD_GROUPS)} />
        <Field {...fieldProps} label="Donor status" name="status" required choices={["Active", "Inactive"]} />
        <div className="col-12 donor-form-section"><span className="donor-section-number">03</span><h6>Phenotypic / physical attributes</h6></div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="donorHeight">Height</label>
          <input className="form-control" id="donorHeight" placeholder="e.g. 5.8 ft" autoComplete="off" value={form.height} onChange={event => setForm(current => ({ ...current, height: event.target.value }))} />
          <div className="form-text">Quick picks use feet.inches notation (5.8 means 5 ft 8 in). You can also enter another height manually.</div>
          <div className="d-flex flex-wrap gap-2 mt-2">
            {HEIGHT_QUICK_PICKS.map(value => {
              const selected = form.height.trim() === value;
              return <button key={value} className={`btn btn-sm border ${selected ? "btn-primary text-white" : "btn-light"}`} type="button" onClick={() => setForm(current => ({ ...current, height: value }))}>{value}</button>;
            })}
          </div>
        </div>
        <Field {...fieldProps} label="Skin tone" name="complexion" choices={selectChoices("skin tone", DONOR_TRAIT_OPTIONS.complexion)} />
        <Field {...fieldProps} label="Eye colour" name="eyeColour" choices={selectChoices("eye colour", DONOR_TRAIT_OPTIONS.eyeColour)} />
        <Field {...fieldProps} label="Hair colour" name="hairColour" choices={selectChoices("hair colour", DONOR_TRAIT_OPTIONS.hairColour)} />
        <Field {...fieldProps} label="Build" name="build" choices={selectChoices("build", DONOR_TRAIT_OPTIONS.build)} />
      </form>
    </Modal>
  );
}

function DonorDetailModal({ donor, onClose }) {
  const batches = usePagedList("/batches", { q: donor.donorId });
  const vials = usePagedList("/vials", { donorId: donor.donorId });
  const [files, setFiles] = useState(null);
  const [filesError, setFilesError] = useState("");

  useEffect(() => {
    let active = true;
    const fetchCategory = category => apiRequest(`/attachments?${new URLSearchParams({ hospitalId: "ART_BANK", centreId: "ART_BANK", relatedId: donor.donorId, category, limit: "100" })}`);
    Promise.all([fetchCategory("DONOR_AADHAAR"), fetchCategory("DONOR_DOCUMENT")])
      .then(results => { if (active) setFiles(results.flatMap(result => result.data || [])); })
      .catch(error => { if (active) setFilesError(`Could not load donor documents: ${error.message}`); });
    return () => { active = false; };
  }, [donor.donorId]);

  const details = [
    ["UHID", donor.uhid || donor.donorId], ["Unit Number", donor.unitNumber], ["Manual donor ID", donor.manualDonorId], ["Name", donor.name],
    ["Marital status", donor.maritalStatus], ["Date of birth", displayDob(donor.dob)], ["Age", ageFromDob(donor.dob)],
    ["Blood group", normalizeBloodGroup(donor.bloodGroup)], ["Height", donor.height], ["Skin tone", donor.complexion], ["Eye colour", donor.eyeColour],
    ["Hair colour", donor.hairColour], ["Build", donor.build], ["Status", donor.status || "Active"]
  ];
  const links = (files || []).flatMap(attachment => (attachment.files || []).map(file => ({ attachment, file })));

  return (
    <Modal title="Donor record" onClose={onClose} className="donor-record-modal">
      <div className="donor-profile-summary">
        {details.map(([label, value]) => <div className="donor-profile-field" key={label}><div className="detail-label">{label}</div><div className="detail-value">{value || "—"}</div></div>)}
      </div>
      <div className="donor-privacy-note"><Icon name="shield-lock" /><span>Full Aadhaar is not stored. The backend retains a verification hash and masked Aadhaar digits.</span></div>
      <section className="donor-traceability-section">
        <h6><Icon name="collection" />Collection batches</h6>
        <Alert message={batches.error} />
        <DataTable headers={["Batch ID", "Collection", "Vials", "Status"]} empty={batches.loading ? "Loading records…" : "No collection batches found"}>
          {batches.records.map(batch => <tr key={batch.batchId}><td>{batch.batchId}</td><td>{localDate(batch.collectionAt)}</td><td>{batch.vialCount ?? "—"}</td><td><Badge status={batch.releaseStatus} /></td></tr>)}
        </DataTable>
        <LoadMore list={batches} />
      </section>
      <section className="donor-traceability-section">
        <h6><Icon name="droplet-half" />Vial traceability</h6>
        <Alert message={vials.error} />
        <DataTable headers={["Vial ID", "Batch", "Blood group", "Location", "Status"]} empty={vials.loading ? "Loading records…" : "No vial records found"}>
          {vials.records.map(vial => <tr key={vial.vialId}><td>{vial.vialId}</td><td>{vial.batchId || "—"}</td><td>{normalizeBloodGroup(vial.bloodGroup) || "—"}</td><td>{vial.currentLocation || "—"}</td><td><Badge status={vial.status} /></td></tr>)}
        </DataTable>
        <LoadMore list={vials} />
      </section>
      <section className="donor-traceability-section">
        <h6><Icon name="folder2-open" />Donor documents</h6>
        {filesError ? <span className="text-danger small">{filesError}</span> : links.length ? links.map(({ attachment, file }) => (
          <button key={file.fileId} type="button" className="btn btn-link btn-sm p-0 me-3" onClick={() => downloadAttachment(attachment.attachmentId, file.fileId, file.originalName).catch(error => setFilesError(error.message))}>
            {file.label || file.originalName}
          </button>
        )) : <span className="text-secondary small">{files ? "No donor files available" : "Loading documents…"}</span>}
      </section>
    </Modal>
  );
}

export default function DonorsPage() {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null);
  const list = usePagedList("/donors", { q: search.trim() });

  return (
    <>
      <PageTitle title="Donors" subtitle="Donor master · visible to ART Bank roles only" action={<button className="btn btn-primary" type="button" onClick={() => setCreating(true)}><Icon name="plus-lg" className="me-1" />Register donor</button>} />
      <Alert message={list.error} />
      <div className="section-card">
        <div className="card-head">
          <input className="form-control" style={{ maxWidth: 360 }} placeholder="Search UHID, donor ID, legacy Unit Number or name" value={search} onChange={event => setSearch(event.target.value)} />
          <span className="small text-secondary ms-auto">{list.records.length} loaded · {list.pagination?.total ?? list.records.length} matches</span>
        </div>
        <DataTable headers={["UHID", "Unit Number", "Name", "DOB", "Age", "Blood group", "Status", ""]} empty={list.loading ? "Loading donors…" : "No donors found"}>
          {list.records.map(donor => (
            <tr key={donor.donorId}>
              <td className="fw-semibold">{donor.uhid || donor.donorId}</td>
              <td>{donor.unitNumber || "—"}</td>
              <td>{donor.name}</td>
              <td>{displayDob(donor.dob) || "—"}</td>
              <td>{ageFromDob(donor.dob) || "—"}</td>
              <td>{normalizeBloodGroup(donor.bloodGroup) || "—"}</td>
              <td><Badge status={donor.status || "Active"} /></td>
              <td><button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setSelected(donor)}>View</button></td>
            </tr>
          ))}
        </DataTable>
        <LoadMore list={list} label="donors" />
      </div>
      {creating && <NewDonorModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); list.reload(); }} />}
      {selected && <DonorDetailModal donor={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

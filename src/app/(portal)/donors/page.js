"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, BloodPill, DataTable, Field, Icon, IdTag, LoadMore, Modal, PageTitle, selectChoices, usePagedList } from "@/components/ui";
import { apiRequest, downloadAttachment, downloadFile } from "@/lib/api";
import { BLOOD_GROUPS, DONOR_TRAIT_OPTIONS, HEIGHT_QUICK_PICKS, ageFromDob, displayDob, localDate, normalizeBloodGroup, validUploadFile } from "@/lib/format";

const DONOR_STATUSES = ["Active", "Inactive", "Retired"];
const MARITAL_LABELS = { MARRIED: "Married", UNMARRIED: "Unmarried" };
const VIRAL = [{ value: "NON_REACTIVE", label: "Non-reactive" }, { value: "REACTIVE", label: "Reactive" }, { value: "PENDING", label: "Pending" }];
const SCREENING_TESTS = [
  { key: "hiv", label: "HIV 1 & 2 (antibody / antigen)", choices: VIRAL },
  { key: "hbsag", label: "HBsAg (hepatitis B)", choices: VIRAL },
  { key: "hcv", label: "HCV (hepatitis C)", choices: VIRAL },
  { key: "vdrl", label: "VDRL / syphilis", choices: VIRAL },
  { key: "thalassemia", label: "Thalassemia HPLC", choices: [{ value: "NORMAL", label: "Normal / negative" }, { value: "CARRIER", label: "Carrier" }, { value: "PENDING", label: "Pending" }] },
  { key: "karyotype", label: "Karyotyping", choices: [{ value: "NORMAL", label: "Normal" }, { value: "ABNORMAL", label: "Abnormal" }, { value: "PENDING", label: "Pending" }] }
];
const compactId = value => String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const screeningLabel = (test, value) => test.choices.find(choice => choice.value === value)?.label || "Not recorded";
const screeningTone = value => (["NON_REACTIVE", "NORMAL"].includes(value) ? "badge-green" : ["REACTIVE", "ABNORMAL", "CARRIER"].includes(value) ? "badge-red" : "badge-gray");

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
        <Field {...fieldProps} label="Donor status" name="status" required choices={DONOR_STATUSES} />
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

function ScreeningSection({ donor, onSaved }) {
  const current = donor.screening || {};
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setForm({ ...Object.fromEntries(SCREENING_TESTS.map(test => [test.key, current[test.key] || ""])), testedOn: current.testedOn ? String(current.testedOn).slice(0, 10) : "" });
    setError("");
    setEditing(true);
  };
  const save = async event => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await apiRequest(`/donors/${encodeURIComponent(donor.donorId)}/screening`, { method: "PATCH", body: form });
      setEditing(false);
      onSaved(result.data);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="donor-traceability-section">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <h6 className="mb-0"><Icon name="clipboard2-pulse" />Screening clearances (ART Act)</h6>
        {!editing && <button className="btn btn-sm btn-outline-primary" type="button" onClick={startEdit}>{current.updatedAt ? "Update results" : "Record results"}</button>}
      </div>
      {editing ? (
        <form className="row g-2" onSubmit={save}>
          <Alert message={error} />
          {SCREENING_TESTS.map(test => (
            <Field key={test.key} form={form} setForm={setForm} label={test.label} name={test.key} col="col-md-4" choices={[{ value: "", label: "Not recorded" }, ...test.choices]} />
          ))}
          <Field form={form} setForm={setForm} label="Test date" name="testedOn" type="date" col="col-md-4" />
          <div className="col-12 d-flex gap-2">
            <button className="btn btn-primary btn-sm" disabled={saving}>{saving ? "Saving…" : "Save results"}</button>
            <button className="btn btn-light btn-sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <div className="row g-2">
            {SCREENING_TESTS.map(test => (
              <div className="col-md-4" key={test.key}>
                <div className="detail-label">{test.label}</div>
                <span className={`badge-soft ${screeningTone(current[test.key])}`}>{screeningLabel(test, current[test.key])}</span>
              </div>
            ))}
          </div>
          {current.updatedAt && <div className="small text-secondary mt-2">Tested {current.testedOn ? localDate(current.testedOn) : "date not recorded"} · recorded by {current.updatedBy || "—"} on {localDate(current.updatedAt)}</div>}
        </>
      )}
    </section>
  );
}

function DonorStatusControl({ donor, onSaved }) {
  const [status, setStatus] = useState(donor.status || "Active");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const changed = status !== (donor.status || "Active");

  const save = async () => {
    if (status !== "Active" && !window.confirm(`Mark this donor as ${status}? ${status} donors cannot be used for new collections or stock requests.`)) return;
    setSaving(true);
    setError("");
    try {
      const result = await apiRequest(`/donors/${encodeURIComponent(donor.donorId)}/status`, { method: "PATCH", body: { status } });
      onSaved(result.data);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
      <label className="small text-secondary" htmlFor="donorStatusChange">Donor status</label>
      <select id="donorStatusChange" className="form-select form-select-sm" style={{ maxWidth: 160 }} value={status} onChange={event => setStatus(event.target.value)}>
        {DONOR_STATUSES.map(value => <option key={value}>{value}</option>)}
      </select>
      <button className="btn btn-sm btn-outline-primary" type="button" disabled={!changed || saving} onClick={save}>{saving ? "Saving…" : "Change status"}</button>
      {error && <span className="text-danger small">{error}</span>}
    </div>
  );
}

function DonorDetailModal({ donor: initialDonor, onClose, onChanged }) {
  const { user } = useSession();
  const [donor, setDonor] = useState(initialDonor);
  const updateDonor = updated => {
    setDonor(current => ({ ...current, ...updated }));
    onChanged();
  };
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
    ["Marital status", MARITAL_LABELS[donor.maritalStatus] || donor.maritalStatus], ["Aadhaar (masked)", donor.aadhaarMasked], ["Date of birth", displayDob(donor.dob)], ["Age", ageFromDob(donor.dob)],
    ["Blood group", normalizeBloodGroup(donor.bloodGroup)], ["Height", donor.height], ["Skin tone", donor.complexion], ["Eye colour", donor.eyeColour],
    ["Hair colour", donor.hairColour], ["Build", donor.build], ["Status", donor.status || "Active"]
  ];
  const links = (files || []).flatMap(attachment => (attachment.files || []).map(file => ({ attachment, file })));

  return (
    <Modal title="Donor record" onClose={onClose} className="donor-record-modal">
      <div className="row g-2 mb-3 text-center">
        {[["1. UHID", donor.uhid || donor.donorId], ["2. Donor ID", donor.manualDonorId || "—"], ["3. Batches", donor.trace?.batchIds?.length ?? "—"], ["4. Vials", donor.trace ? `${donor.trace.vialAvailable} available / ${donor.trace.vialTotal}` : "—"]].map(([label, value]) => (
          <div className="col-6 col-md-3" key={label}><div className="stat-card py-2"><div className="stat-label">{label}</div><div className="fw-semibold">{value}</div></div></div>
        ))}
      </div>
      {["SUPER_ADMIN", "ART_BANK_ADMIN"].includes(user?.role) && <DonorStatusControl key={donor.status} donor={donor} onSaved={updateDonor} />}
      <div className="donor-profile-summary">
        {details.map(([label, value]) => <div className="donor-profile-field" key={label}><div className="detail-label">{label}</div><div className="detail-value">{value || "—"}</div></div>)}
      </div>
      <div className="donor-privacy-note"><Icon name="shield-lock" /><span>Full Aadhaar is not stored. The backend retains a verification hash and masked Aadhaar digits.</span></div>
      <ScreeningSection donor={donor} onSaved={updateDonor} />
      <section className="donor-traceability-section">
        <h6><Icon name="collection" />Collection batches</h6>
        <Alert message={batches.error} />
        <DataTable headers={["Batch ID", "Collection", "Vials", "Status"]} empty={batches.loading ? "Loading records…" : "No collection batches found"}>
          {batches.records.map(batch => <tr key={batch.batchId}><td><IdTag value={batch.batchId} icon="layers" /></td><td>{localDate(batch.collectionAt)}</td><td>{batch.vialCount ?? "—"}</td><td><Badge status={batch.releaseStatus} /></td></tr>)}
        </DataTable>
        <LoadMore list={batches} />
      </section>
      <section className="donor-traceability-section">
        <h6><Icon name="droplet-half" />Vial traceability</h6>
        <Alert message={vials.error} />
        <DataTable headers={["Vial ID", "Batch", "Blood group", "Location", "Status"]} empty={vials.loading ? "Loading records…" : "No vial records found"}>
          {vials.records.map(vial => <tr key={vial.vialId}><td><IdTag value={vial.vialId} icon="droplet-half" /></td><td><IdTag value={vial.batchId} tone="slate" /></td><td><BloodPill value={normalizeBloodGroup(vial.bloodGroup)} /></td><td>{vial.currentLocation || "—"}</td><td><Badge status={vial.status} /></td></tr>)}
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

// Downloads the donor's Aadhaar scan on demand, so the list does not load every file up front.
function AadhaarFileChip({ donor, onError }) {
  const [state, setState] = useState("idle");
  const open = async () => {
    setState("loading");
    onError("");
    try {
      const params = new URLSearchParams({ hospitalId: "ART_BANK", centreId: "ART_BANK", relatedId: donor.donorId, category: "DONOR_AADHAAR", limit: "5" });
      const attachment = ((await apiRequest(`/attachments?${params}`)).data || []).find(item => item.files?.length);
      if (!attachment) {
        setState("none");
        return;
      }
      const file = attachment.files[0];
      await downloadAttachment(attachment.attachmentId, file.fileId, file.originalName);
      setState("idle");
    } catch (error) {
      setState("idle");
      onError(`Could not open the Aadhaar file: ${error.message}`);
    }
  };
  if (state === "none") return <span className="nl-mono-muted">No file uploaded</span>;
  return (
    <button type="button" className="nl-file-chip" onClick={open} disabled={state === "loading"} title="Download Aadhaar scan">
      <Icon name="file-earmark-pdf-fill" />{state === "loading" ? "Opening…" : `aadhaar_${(donor.manualDonorId || donor.uhid || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`}
    </button>
  );
}

function QuickUhidTrace({ onFound }) {
  const [uhid, setUhid] = useState("");
  const [message, setMessage] = useState("");
  const [choices, setChoices] = useState([]);
  const [busy, setBusy] = useState(false);

  const trace = async event => {
    event.preventDefault();
    const value = uhid.trim();
    if (!value) return;
    setBusy(true);
    setMessage("");
    setChoices([]);
    try {
      const params = new URLSearchParams({ q: value, limit: "20" });
      const matches = (await apiRequest(`/donors?${params}`)).data || [];
      const typed = compactId(value);
      const exact = matches.filter(donor => [donor.uhid, donor.manualDonorId, donor.unitNumber].some(id => id && compactId(id) === typed));
      const found = exact.length === 1 ? exact : matches;
      if (found.length === 1) onFound(found[0]);
      else if (found.length > 1) setChoices(found);
      else setMessage(`No donor matches ${value}.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="nl-trace mb-3" onSubmit={trace}>
      <div className="nl-trace-icon"><Icon name="fingerprint" /></div>
      <div className="flex-grow-1">
        <div className="nl-trace-title">Quick UHID traceability search <span className="nl-trace-tag">Letters optional</span></div>
        <div className="nl-trace-help">Search a donor by UHID or donor ID, with or without letters and symbols. For example P9R45, O/55132, O55132 or 55132.</div>
        <div className="d-flex flex-wrap gap-2 mt-2">
          <input className="form-control nl-trace-input" placeholder="Enter UHID or donor ID…" value={uhid} maxLength={50} onChange={event => setUhid(event.target.value)} aria-label="UHID or donor ID" />
          <button className="btn nl-btn-dark" disabled={busy}><Icon name="search" className="me-1" />{busy ? "Searching…" : "Trace"}</button>
        </div>
        {message && <div className="small text-danger mt-2">{message}</div>}
        {choices.length > 0 && (
          <div className="mt-2">
            <div className="small text-secondary mb-1">{choices.length} donors match. Choose one:</div>
            <div className="d-flex flex-wrap gap-2">
              {choices.map(donor => (
                <button key={donor.donorId} type="button" className="nl-choice" onClick={() => { setChoices([]); onFound(donor); }}>
                  <span className="nl-uhid">{donor.uhid || donor.donorId}</span> {donor.manualDonorId || ""} · {donor.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </form>
  );
}

export default function DonorsPage() {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({ maritalStatus: "", bloodGroup: "", status: "" });
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null);
  const [exportError, setExportError] = useState("");
  const query = { q: search.trim(), ...filters };
  const list = usePagedList("/donors", query);
  const setFilter = key => event => setFilters(current => ({ ...current, [key]: event.target.value }));

  const exportCsv = () => {
    setExportError("");
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value));
    downloadFile(`/reports/donors.csv${params.size ? `?${params}` : ""}`, "donor-registry.csv").catch(error => setExportError(error.message));
  };

  return (
    <>
      <PageTitle title="ART Donor Registry & Traceability" count={list.pagination ? `${list.pagination.total} registered donors` : undefined} subtitle="Statutory 4-tier traceability chain: UHID → manual donor ID → collection batch → vial IDs. Visible to ART Bank roles only." action={
        <div className="d-flex flex-wrap gap-2">
          <button className="btn btn-outline-primary nl-btn-export" type="button" onClick={exportCsv}><Icon name="download" className="me-1" />Export CSV</button>
          <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}><Icon name="plus-lg" className="me-1" />Register donor</button>
        </div>
      } />
      <Alert message={list.error || exportError} />
      <QuickUhidTrace onFound={setSelected} />
      <div className="section-card">
        <div className="card-head flex-wrap gap-2">
          <input className="form-control" style={{ maxWidth: 320 }} placeholder="Search UHID, donor ID, Unit Number or name" value={search} onChange={event => setSearch(event.target.value)} />
          <select className="form-select" style={{ maxWidth: 170 }} value={filters.maritalStatus} onChange={setFilter("maritalStatus")} aria-label="Marital status">
            <option value="">All marital statuses</option><option value="MARRIED">Married</option><option value="UNMARRIED">Unmarried</option>
          </select>
          <select className="form-select" style={{ maxWidth: 150 }} value={filters.bloodGroup} onChange={setFilter("bloodGroup")} aria-label="Blood group">
            <option value="">All blood groups</option>{BLOOD_GROUPS.map(group => <option key={group}>{group}</option>)}
          </select>
          <select className="form-select" style={{ maxWidth: 140 }} value={filters.status} onChange={setFilter("status")} aria-label="Donor status">
            <option value="">All statuses</option>{DONOR_STATUSES.map(value => <option key={value}>{value}</option>)}
          </select>
          <span className="small text-secondary ms-auto">{list.records.length} loaded · {list.pagination?.total ?? list.records.length} matches</span>
        </div>
        <div className="nl-table">
          <DataTable headers={["UHID (5-digit)", "Donor ID (manual)", "Donor legal name", "Marital status", "Blood group", "Age / DOB", "Aadhaar PDF", "Batches & vials trace", "Status", "Action"]} empty={list.loading ? "Loading donors…" : "No donors found"}>
            {list.records.map(donor => (
              <tr key={donor.donorId}>
                <td><span className="nl-uhid"><Icon name="fingerprint" />{donor.uhid || donor.donorId}</span></td>
                <td><span className="nl-donor-id"><Icon name="lock-fill" />{donor.manualDonorId || donor.unitNumber || "—"}</span></td>
                <td>
                  <div className="fw-semibold">{donor.name}</div>
                  <div className="nl-mono-muted">Aadhaar: {donor.aadhaarMasked || "—"}</div>
                </td>
                <td>{donor.maritalStatus ? <span className={`nl-pill ${donor.maritalStatus === "MARRIED" ? "nl-pill-married" : "nl-pill-unmarried"}`}><Icon name={donor.maritalStatus === "MARRIED" ? "heart" : "person"} />{MARITAL_LABELS[donor.maritalStatus]}</span> : "—"}</td>
                <td>{donor.bloodGroup ? <span className="nl-pill nl-pill-blood">{normalizeBloodGroup(donor.bloodGroup)}</span> : "—"}</td>
                <td><div className="fw-semibold">{ageFromDob(donor.dob) ? `${ageFromDob(donor.dob)} Yrs` : "—"}</div><div className="nl-mono-muted">{donor.dob ? String(donor.dob).slice(0, 10) : ""}</div></td>
                <td><AadhaarFileChip donor={donor} onError={setExportError} /></td>
                <td>
                  <div className="nl-trace-line"><Icon name="layers" /><span className="text-secondary">Batches:</span> <span className="nl-mono">{donor.trace?.batchIds?.length ? donor.trace.batchIds.join(", ") : "None"}</span></div>
                  <div className="nl-mono-muted">Vials: {donor.trace?.vialTotal ?? 0} total (<span className="nl-available">{donor.trace?.vialAvailable ?? 0} available</span>)</div>
                </td>
                <td><Badge status={donor.status || "Active"} /></td>
                <td className="text-end"><button className="btn btn-sm nl-btn-dark" type="button" onClick={() => setSelected(donor)}><Icon name="eye" className="me-1" />View Profile</button></td>
              </tr>
            ))}
          </DataTable>
        </div>
        <LoadMore list={list} label="donors" />
      </div>
      {creating && <NewDonorModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); list.reload(); }} />}
      {selected && <DonorDetailModal key={selected.donorId} donor={selected} onClose={() => setSelected(null)} onChanged={list.reload} />}
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_BANK_NAME, DEFAULT_BANK_REGD_NO, DeclarationPreviewModal } from "@/components/DeclarationPaper";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, DataTable, Field, Icon, IdTag, LoadErrors, LoadMore, Modal, PageTitle, useLoader, usePagedList } from "@/components/ui";
import { apiRequest, loadAll } from "@/lib/api";
import { canOperateBank, localDateTime, todayIso } from "@/lib/format";

const extractRecords = result => result.data?.records || [];
const compactId = value => String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const maskDigits = mask => ((mask || "").length >= 12 ? { first: mask.slice(0, 2), last: mask.slice(-2) } : { first: "", last: "" });
const nowTime = () => { const now = new Date(); return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`; };
const BANK_KEY = "declarationBankDetails";
// The bank name and registration number rarely change, so the last ones used are remembered in this browser.
const rememberedBank = () => {
  try { return { bankName: DEFAULT_BANK_NAME, bankRegistrationNumber: DEFAULT_BANK_REGD_NO, ...JSON.parse(localStorage.getItem(BANK_KEY) || "{}") }; }
  catch { return { bankName: DEFAULT_BANK_NAME, bankRegistrationNumber: DEFAULT_BANK_REGD_NO }; }
};
const hospitalNames = (hospitals, hospitalId, centreId) => {
  const hospital = hospitals.find(item => item.hospitalId === hospitalId);
  return { hospitalName: hospital?.hospitalName || hospitalId, centreName: hospital?.centres?.find(item => item.centreId === centreId)?.centreName || "" };
};

// Step 1: staff type the donor ID. Step 2: only couple cases whose mapped vials all came from that donor are listed.
function NewDeclarationModal({ couples, signers, hospitals, onClose, onSaved }) {
  const today = todayIso();
  const activeSigners = signers.filter(signer => signer.status === "ACTIVE");
  const [bank, setBank] = useState(rememberedBank);
  const [donorQuery, setDonorQuery] = useState("");
  const [donorMatches, setDonorMatches] = useState([]);
  const [donor, setDonor] = useState(null);
  const [linkedCases, setLinkedCases] = useState([]);
  const [lookup, setLookup] = useState({ busy: false, message: "Type the donor ID, e.g. AB/6283 or AB6283." });
  const [form, setForm] = useState({ coupleId: "", patientName: "", registrationId: "", date: today, reportTime: nowTime(), sampleDate: today, sampleTime: nowTime(), sampleId: "", signerId: activeSigners[0]?.signerId || "", first: "", last: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const formRef = useRef(null);

  const couple = linkedCases.find(item => item.coupleId === form.coupleId);
  const maskLocked = (donor?.aadhaarMasked || "").length >= 12;
  const digits = value => value.replace(/\D/g, "").slice(0, 2);

  const fillFromCase = selected => setForm(current => ({
    ...current, coupleId: selected?.coupleId || "",
    patientName: selected?.wife?.name || selected?.husband?.name || ""
  }));

  // Loads the donor's vials and keeps only cases whose mapped vials all belong to this donor.
  const chooseDonor = async chosen => {
    setDonor(chosen);
    setDonorMatches([]);
    setDonorQuery(chosen.manualDonorId || chosen.uhid || chosen.donorId);
    setForm(current => ({ ...current, ...maskDigits(chosen.aadhaarMasked), registrationId: chosen.manualDonorId || chosen.uhid || chosen.donorId }));
    setLookup({ busy: true, message: "Finding couple cases linked to this donor…" });
    try {
      const donorVials = (await apiRequest(`/vials?${new URLSearchParams({ donorId: chosen.donorId, limit: "500" })}`)).data || [];
      const donorVialIds = new Set(donorVials.map(vial => vial.vialId));
      const cases = couples.filter(item => item.mappedVialIds?.length && item.mappedVialIds.every(id => donorVialIds.has(id)));
      setLinkedCases(cases);
      fillFromCase(cases[0]);
      setLookup({ busy: false, message: cases.length ? `${cases.length} couple case${cases.length === 1 ? "" : "s"} linked to this donor.` : "No couple case has vials mapped from this donor yet." });
    } catch (lookupError) {
      setLinkedCases([]);
      setLookup({ busy: false, message: lookupError.message || "Could not load the donor's cases. Try again." });
    }
  };

  useEffect(() => {
    const typed = donorQuery.trim();
    if (donor && compactId(typed) === compactId(donor.manualDonorId || donor.uhid || donor.donorId)) return undefined;
    if (compactId(typed).length < 2) {
      setDonorMatches([]);
      return undefined;
    }
    const timer = setTimeout(async () => {
      setLookup({ busy: true, message: "Searching donors…" });
      try {
        const found = (await apiRequest(`/donors?${new URLSearchParams({ q: typed, limit: "10" })}`)).data || [];
        const exact = found.filter(item => [item.manualDonorId, item.uhid, item.unitNumber].some(id => id && compactId(id) === compactId(typed)));
        if (exact.length === 1) return chooseDonor(exact[0]);
        setDonorMatches(found);
        setLookup({ busy: false, message: found.length ? "Select the donor below." : "No donor matches this ID." });
      } catch (searchError) {
        setLookup({ busy: false, message: searchError.message || "Search failed. Try again." });
      }
      return undefined;
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [donorQuery]);

  const changeDonorQuery = value => {
    setDonorQuery(value);
    setDonor(null);
    setLinkedCases([]);
    fillFromCase(null);
  };

  const buildData = () => ({
    date: form.date, reportTime: form.reportTime, sampleDate: form.sampleDate, sampleTime: form.sampleTime, sampleId: form.sampleId.trim(),
    patientName: form.patientName.trim(), registrationId: form.registrationId.trim(),
    bankName: bank.bankName.trim(), bankRegistrationNumber: bank.bankRegistrationNumber.trim(),
    ...hospitalNames(hospitals, couple.hospitalId, couple.centreId),
    vials: couple.mappedVialIds, donor: donor.donorId, aadhaarMasked: `${form.first}••••••••${form.last}`, signerId: form.signerId
  });

  const check = () => {
    if (!donor) return "Search for and select the donor first.";
    if (!couple) return "Select a couple case linked to this donor.";
    if (!formRef.current.reportValidity()) return "skip";
    if (!/^\d{2}$/.test(form.first) || !/^\d{2}$/.test(form.last)) return "Enter exactly two Aadhaar digits at each end. Never enter the full Aadhaar number.";
    return "";
  };

  const showPreview = () => {
    const problem = check();
    if (problem) return problem === "skip" ? undefined : setError(problem);
    setError("");
    setPreview({
      declaration: { declarationId: "PREVIEW", coupleId: couple.coupleId, hospitalId: couple.hospitalId, centreId: couple.centreId, vialIds: couple.mappedVialIds, declarationData: { ...buildData(), aadhaarMasked: donor.aadhaarMasked || "" } },
      couple, donor, signer: signers.find(item => item.signerId === form.signerId)
    });
    // Remember the bank details as soon as they have been previewed.
    try { localStorage.setItem(BANK_KEY, JSON.stringify(bank)); } catch { /* storage unavailable */ }
  };

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    const problem = check();
    if (problem) return problem === "skip" ? undefined : setError(problem);
    setError("");
    setSaving(true);
    try { localStorage.setItem(BANK_KEY, JSON.stringify({ bankName: bank.bankName.trim(), bankRegistrationNumber: bank.bankRegistrationNumber.trim() })); } catch { /* storage unavailable */ }
    try {
      await apiRequest("/declarations", { method: "POST", body: { coupleId: couple.coupleId, declarationType: "ART_BANK", confirmations: { detailsVerified: true }, declarationData: buildData() } });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  const fieldProps = { form, setForm };
  return (
    <>
      <Modal title="Create declaration" className={preview ? "d-none" : ""} onClose={preview ? undefined : onClose} footer={<>
        <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-outline-primary" type="button" onClick={showPreview}>Preview</button>
        <button className="btn btn-primary" form="declarationForm" disabled={saving || !couple}>{saving ? "Saving…" : "Save draft"}</button>
      </>}>
        <Alert message={error} />
        <form id="declarationForm" ref={formRef} className="row g-3" onSubmit={submit}>
          <div className="col-12">
            <label className="form-label" htmlFor="decDonorSearch">Donor ID <span className="text-danger">*</span></label>
            <div className="map-vial-search">
              <Icon name="search" />
              <input id="decDonorSearch" className="form-control" autoComplete="off" autoFocus placeholder="Enter the donor ID, e.g. AB/6283 or AB6283" value={donorQuery} onChange={event => changeDonorQuery(event.target.value)} />
            </div>
            <div className="small text-secondary mt-2" aria-live="polite">{lookup.message}</div>
            {!donor && donorMatches.length > 0 && (
              <div className="map-vial-results" role="listbox" aria-label="Matching donors">
                {donorMatches.map(item => (
                  <button key={item.donorId} type="button" role="option" aria-selected="false" className="map-vial-option" onClick={() => chooseDonor(item)}>
                    <span className="nl-donor-id"><Icon name="lock-fill" />{item.manualDonorId || "—"}</span>
                    <IdTag value={item.uhid || item.donorId} icon="fingerprint" tone="slate" />
                    <span className="small">{item.name}</span>
                    <span className="nl-pill nl-pill-blood">{item.bloodGroup || "—"}</span>
                  </button>
                ))}
              </div>
            )}
            {donor && (
              <div className="map-vial-selected d-flex flex-wrap align-items-center gap-2">
                <Icon name="check-circle-fill" className="text-success" />
                <span className="nl-donor-id"><Icon name="lock-fill" />{donor.manualDonorId || "—"}</span>
                <IdTag value={donor.uhid || donor.donorId} icon="fingerprint" tone="slate" />
                <span className="small fw-semibold">{donor.name}</span>
                <span className="nl-pill nl-pill-blood">{donor.bloodGroup || "—"}</span>
                <span className="small text-secondary">Aadhaar {donor.aadhaarMasked || "not recorded"}</span>
              </div>
            )}
          </div>
          {donor && (
            <>
              <Field {...fieldProps} label="Couple case linked to this donor" name="coupleId" required disabled={!linkedCases.length}
                onValue={value => { fillFromCase(linkedCases.find(item => item.coupleId === value)); return value; }}
                choices={linkedCases.length ? linkedCases.map(item => ({ value: item.coupleId, label: `${item.coupleId} · ${item.hospitalId} · ${(item.mappedVialIds || []).join(", ")}` })) : [{ value: "", label: "No linked case" }]} />
              <Field {...fieldProps} label="Patient name" name="patientName" required />
              <Field {...fieldProps} label="Registration ID" name="registrationId" required />
              <Field {...fieldProps} label="Sample date" name="sampleDate" type="date" required col="col-md-3" />
              <Field {...fieldProps} label="Sample time" name="sampleTime" type="time" required col="col-md-3" />
              <Field {...fieldProps} label="Report date" name="date" type="date" required col="col-md-3" />
              <Field {...fieldProps} label="Report time" name="reportTime" type="time" required col="col-md-3" />
              <Field {...fieldProps} label="Sample ID (barcode)" name="sampleId" maxLength={40} placeholder="Leave blank to use the declaration ID" hint="Letters, numbers and symbols print as a barcode." />
              <Field form={bank} setForm={setBank} label="ART Bank name" name="bankName" required maxLength={120} />
              <Field form={bank} setForm={setBank} label="ART Bank regd. no." name="bankRegistrationNumber" required maxLength={80} placeholder="e.g. PB/AB/2022/10041/AB/SAS Nagar/017" />
              <Field {...fieldProps} label="Authorised signatory" name="signerId" required choices={activeSigners.length ? activeSigners.map(signer => ({ value: signer.signerId, label: `${signer.name} · ${signer.designation} · v${signer.version}` })) : [{ value: "", label: "No active signatory available" }]} />
              <Field {...fieldProps} label="Donor Aadhaar first two digits" name="first" required placeholder="00" maxLength={2} inputMode="numeric" readOnly={maskLocked} onValue={digits} />
              <Field {...fieldProps} label="Donor Aadhaar last two digits" name="last" required placeholder="00" maxLength={2} inputMode="numeric" readOnly={maskLocked} onValue={digits} />
            </>
          )}
        </form>
      </Modal>
      {preview && <DeclarationPreviewModal {...preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function CorrectionRequestModal({ declaration, revisionOf, onClose, onSaved }) {
  const data = declaration.declarationData || {};
  const prior = Object.fromEntries((revisionOf?.proposedChanges || []).map(change => [change.field, change.value]));
  const [form, setForm] = useState({ date: prior.date ?? data.date ?? "", reason: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    const proposedChanges = [];
    if (form.date && form.date !== data.date) proposedChanges.push({ field: "date", value: form.date });
    if (!proposedChanges.length) return setError("Change the report date before submitting a correction.");
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
        <div className="col-12"><label className="form-label" htmlFor="correctionReason">Reason for correction</label><textarea id="correctionReason" className="form-control" rows={2} required value={form.reason} onChange={event => setForm(current => ({ ...current, reason: event.target.value }))} /></div>
      </form>
      <p className="small text-secondary mt-3 mb-0">Only the report date can be corrected. ART Bank reviews every request before a new declaration version is created.</p>
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
  const related = useLoader(() => loadAll({ couples: "/couples?limit=500", vials: "/vials?limit=500", donors: bank ? "/donors?limit=500" : null, signers: bank ? "/signers?limit=500" : null, hospitals: "/hospitals" }), [bank]);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(null);

  const results = related.data?.results || {};
  const couples = results.couples?.data || [], vials = results.vials?.data || [], donors = results.donors?.data || [], signers = results.signers?.data || [], hospitals = results.hospitals?.data || [];
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
    setModal({ type: "preview", paper: { declaration, couple, donor, signer, ...hospitalNames(hospitals, declaration.hospitalId, declaration.centreId) } });
  };
  const runAction = async (action, declaration) => {
    setMessage(null);
    const id = encodeURIComponent(declaration.declarationId);
    if (action === "preview") return preview(declaration);
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
      <PageTitle count={list.pagination ? `${list.pagination.total} issued` : undefined} title={hospital ? "Submitted declarations" : "Statutory ART Declarations"} subtitle={hospital ? "Only declarations submitted to your centre are visible" : "Fixed-format declarations, preview and version history"} action={bank && (
        <button className="btn btn-primary" type="button" disabled={unavailable} title={unavailable ? "Retry loading declaration data before creating a declaration" : undefined} onClick={startNew}><Icon name="plus-lg" className="me-1" />Create declaration</button>
      )} />
      <Alert message={message?.text} type={message?.type} onClose={() => setMessage(null)} />
      <Alert message={list.error} />
      <LoadErrors errors={related.data?.errors} />
      <div className="section-card declaration-list-card">
        <DataTable headers={["Declaration", "Donor ID", "Hospital", "Vials", "Version", "Status", "Action"]} empty={list.loading ? "Loading declarations…" : list.error ? "Declaration records could not be loaded. Retry before treating this list as empty." : "No declarations yet"}>
          {list.records.map(declaration => {
            const data = declaration.declarationData || {};
            const options = [
              ["preview", "Preview"],
              ...(bank && ["DRAFT", "SUBMITTED"].includes(declaration.status) ? [["correct", "Correct"]] : []),
              ...(bank && declaration.status === "DRAFT" ? [["submit", "Submit"]] : []),
              ...(bank && declaration.status === "SUBMITTED" ? [["unsubmit", "Unsubmit"]] : []),
              ...(hospital && declaration.status === "SUBMITTED" && !declaration.pendingCorrectionRequestId ? [["request", "Request correction"]] : [])
            ];
            return (
              <tr key={declaration.declarationId}>
                <td><IdTag value={declaration.declarationId} icon="file-earmark-text" /></td>
                <td>{(data.donorNumber || data.donorUhid || data.donor) ? <span className="nl-donor-id"><Icon name="lock-fill" />{data.donorNumber || data.donorUhid || data.donor}</span> : "—"}</td>
                <td>{declaration.hospitalId}</td>
                <td><div className="d-flex flex-wrap gap-1">{(declaration.vialIds || data.vials || []).map(vialId => <IdTag key={vialId} value={vialId} tone="slate" />)}</div></td>
                <td><span className="nl-count">v{declaration.currentVersion || 1}</span></td>
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
                  <td><IdTag value={request.declarationId} icon="file-earmark-text" /></td>
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
      {modal?.type === "new" && <NewDeclarationModal couples={modal.couples} signers={signers} hospitals={hospitals}onClose={() => setModal(null)} onSaved={finish} />}
      {modal?.type === "preview" && <DeclarationPreviewModal {...modal.paper} onClose={() => setModal(null)} />}
      {modal?.type === "request" && <CorrectionRequestModal declaration={modal.declaration} revisionOf={modal.revisionOf} onClose={() => setModal(null)} onSaved={finish} />}
      {modal?.type === "review" && <ReviewCorrectionModal request={modal.request} onClose={() => setModal(null)} onSaved={finish} />}
    </>
  );
}

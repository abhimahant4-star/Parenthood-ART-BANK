"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, DataTable, Field, Icon, IdTag, LoadMore, Modal, PageTitle, usePagedList } from "@/components/ui";
import { apiRequest, downloadAttachment } from "@/lib/api";
import { validUploadFile } from "@/lib/format";

const ID_TYPES = [{ value: "", label: "Select ID type" }, ...["Aadhaar", "Passport", "Voter ID", "Driving licence", "Other approved ID"].map(value => ({ value, label: value }))];
const EMPTY_FORM = { hName: "", hType: "", hNumber: "", wName: "", wType: "", wNumber: "" };

function PartnerFields({ prefix, title, form, setForm, setFile }) {
  const isAadhaar = form[`${prefix}Type`] === "Aadhaar";
  const fieldProps = { form, setForm };
  return (
    <>
      <h6 className="mb-3">{title}</h6>
      <div className="row g-3">
        <Field {...fieldProps} label="Full name" name={`${prefix}Name`} required />
        <Field {...fieldProps} label={<>Identity document type <span className="text-danger" title="Required for at least one partner">*</span></>} name={`${prefix}Type`} choices={ID_TYPES} />
        <Field {...fieldProps} label={<>Identity document number <span className="text-danger" title="Required for at least one partner">*</span></>} name={`${prefix}Number`} maxLength={isAadhaar ? 12 : 160} inputMode={isAadhaar ? "numeric" : "text"} pattern={isAadhaar ? "[0-9]{1,12}" : undefined} title={isAadhaar ? "Aadhaar numbers must contain no more than 12 digits." : undefined} />
        <div className="col-md-6">
          <label className="form-label" htmlFor={`${prefix}File`}>Identity document (optional, PDF/JPG/PNG, max 10 MB)</label>
          <input id={`${prefix}File`} type="file" className="form-control" accept=".pdf,.jpg,.jpeg,.png" onChange={event => setFile(event.target.files[0] || null)} />
        </div>
      </div>
    </>
  );
}

function NewCoupleModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [partnerOneFile, setPartnerOneFile] = useState(null);
  const [partnerTwoFile, setPartnerTwoFile] = useState(null);
  const [createdId, setCreatedId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    const files = [{ label: "Partner one ID", file: partnerOneFile }, { label: "Partner two ID", file: partnerTwoFile }].filter(item => item.file);
    if (files.some(item => !validUploadFile(item.file))) return setError("Uploaded identity files must be PDF, JPG or PNG and no larger than 10 MB each.");
    const husband = { name: form.hName.trim(), idType: form.hType, idNumber: form.hNumber.trim() };
    const wife = { name: form.wName.trim(), idType: form.wType, idNumber: form.wNumber.trim() };
    if (!createdId) {
      if ([husband, wife].some(person => person.idType && !person.idNumber)) return setError("Enter the document number for each selected ID type.");
      if ([husband, wife].some(person => person.idNumber && !person.idType)) return setError("Select the ID type for each entered document number.");
      if (![husband, wife].some(person => person.idType && person.idNumber)) return setError("Enter an ID type and number for at least one partner.");
      if ([husband, wife].some(person => person.idType === "Aadhaar" && person.idNumber && !/^\d{1,12}$/.test(person.idNumber))) return setError("Aadhaar numbers must contain no more than 12 digits.");
    }
    setSaving(true);
    let coupleId = createdId;
    try {
      if (!coupleId) {
        const created = await apiRequest("/couples", { method: "POST", body: { hospitalId: user.hospitalId, centreId: user.centreId, husband, wife } });
        coupleId = created.data.coupleId;
        setCreatedId(coupleId);
      }
      if (files.length) {
        const formData = new FormData();
        formData.append("metadata", JSON.stringify({ hospitalId: user.hospitalId, centreId: user.centreId, relatedId: coupleId, category: "IDENTITY_DOCUMENT", label: `Identity documents for ${coupleId}`, fileLabels: files.map(item => item.label) }));
        files.forEach(item => formData.append("files", item.file));
        try { await apiRequest("/attachments", { method: "POST", formData }); }
        catch (uploadError) { throw new Error(`Couple case ${coupleId} was created, but ID upload failed. Retry the upload here: ${uploadError.message}`); }
      }
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  return (
    <Modal title="Create couple case" onClose={createdId ? onSaved : onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={createdId ? onSaved : onClose}>Cancel</button>
      <button className="btn btn-primary" form="coupleForm" disabled={saving}>{saving ? "Saving…" : createdId ? "Retry upload" : "Create case"}</button>
    </>}>
      <Alert message={error} />
      <form id="coupleForm" onSubmit={submit}>
        <PartnerFields prefix="h" title="Partner one" form={form} setForm={setForm} setFile={setPartnerOneFile} />
        <hr />
        <PartnerFields prefix="w" title="Partner two" form={form} setForm={setForm} setFile={setPartnerTwoFile} />
      </form>
      <p className="small text-secondary mt-3 mb-0"><strong>At least one partner&apos;s ID is required</strong>: choose the ID type and enter its number (Aadhaar, passport, voter ID, driving licence or another approved ID). Aadhaar numbers are up to 12 digits and are stored masked. Uploading a scan of the ID is optional and stored privately.</p>
    </Modal>
  );
}

function CoupleDetailModal({ couple, mayViewIdentity, onClose }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!mayViewIdentity) return undefined;
    let active = true;
    apiRequest(`/attachments?${new URLSearchParams({ relatedId: couple.coupleId, category: "IDENTITY_DOCUMENT", limit: "100" })}`)
      .then(result => { if (active) setFiles((result.data || []).filter(item => item.relatedId === couple.coupleId && item.category === "IDENTITY_DOCUMENT")); })
      .catch(loadError => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [couple.coupleId, mayViewIdentity]);

  const identity = mayViewIdentity ? [
    ["Partner one", couple.husband?.name], ["Partner one ID type", couple.husband?.idType], ["Partner one ID number", couple.husband?.idNumber],
    ["Partner two", couple.wife?.name], ["Partner two ID type", couple.wife?.idType], ["Partner two ID number", couple.wife?.idNumber]
  ] : [];
  const details = [["Case ID", couple.coupleId], ["Hospital / centre", `${couple.hospitalId} / ${couple.centreId}`], ["Status", couple.status], ["Mapped vials", (couple.mappedVialIds || []).join(", ") || "None"], ...identity];
  const links = (files || []).flatMap(attachment => (attachment.files || []).map(file => ({ attachment, file })));

  return (
    <Modal title="Couple case" onClose={onClose}>
      <Alert message={error} />
      <div className="row g-3">
        {details.map(([label, value]) => <div className="col-sm-6" key={label}><div className="detail-label">{label}</div><div className="detail-value">{value || "—"}</div></div>)}
        {mayViewIdentity && (
          <div className="col-12">
            <div className="detail-label">Identity files</div>
            <div>
              {links.length ? links.map(({ attachment, file }) => (
                <button key={file.fileId} type="button" className="btn btn-link p-0 me-2" onClick={() => downloadAttachment(attachment.attachmentId, file.fileId, file.originalName).catch(downloadError => setError(downloadError.message))}>{file.label || file.originalName}</button>
              )) : files ? "No private ID files found" : "Loading…"}
            </div>
          </div>
        )}
      </div>
      {!mayViewIdentity && <div className="alert alert-info mt-3 mb-0">Couple identity data is limited to the hospital and Super Admin.</div>}
    </Modal>
  );
}

// Letters, digits only, upper case: "a+101-2", "A101 2" and "A+101-2" all compare as "A1012".
const compactVialId = value => String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function MapVialModal({ couple, onClose, onSaved }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [selected, setSelected] = useState(null);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState("Type the vial ID printed on the vial label.");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Searches only unused vials in this hospital's own stock, while the user types.
  const search = useCallback(async text => {
    const typed = text.trim();
    if (compactVialId(typed).length < 2) {
      setMatches([]);
      setStatus("Type the vial ID printed on the vial label.");
      return;
    }
    setSearching(true);
    try {
      const result = await apiRequest(`/vials?${new URLSearchParams({ status: "UNUSED_AT_HOSPITAL", q: typed, limit: "20" })}`);
      const found = result.data || [];
      setMatches(found);
      const exact = found.find(vial => compactVialId(vial.vialId) === compactVialId(typed));
      if (exact) {
        setSelected(exact);
        setStatus(`Vial ${exact.vialId} found.`);
      } else {
        setStatus(found.length ? `${found.length} matching vial${found.length === 1 ? "" : "s"} in your unused stock. Select one below.` : "No unused vial in your stock matches this ID. Check the label and try again.");
      }
    } catch (searchError) {
      setStatus(searchError.message || "Search failed. Try again.");
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  const submit = async event => {
    event.preventDefault();
    if (saving || !selected) return;
    setSaving(true);
    setError("");
    try {
      await apiRequest("/mappings", { method: "POST", body: { coupleId: couple.coupleId, vialId: selected.vialId } });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  return (
    <Modal title="Map vial to couple" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="mapForm" disabled={!selected || saving}>{saving ? "Saving…" : selected ? `Map ${selected.vialId}` : "Confirm mapping"}</button>
    </>}>
      <Alert message={error} />
      <form id="mapForm" onSubmit={submit}>
        <label className="form-label" htmlFor="mapVialSearch">Vial ID <span className="text-danger">*</span></label>
        <div className="map-vial-search">
          <Icon name="upc-scan" />
          <input id="mapVialSearch" className="form-control" autoComplete="off" autoFocus placeholder="Enter vial ID, e.g. A+101-2 or A1012" value={query}
            onChange={event => { setQuery(event.target.value); setSelected(null); }} aria-describedby="mapVialStatus" />
        </div>
        <div id="mapVialStatus" className="small text-secondary mt-2" aria-live="polite">{searching ? "Searching…" : status}</div>

        {!selected && matches.length > 0 && (
          <div className="map-vial-results" role="listbox" aria-label="Matching vials">
            {matches.map(vial => (
              <button key={vial.vialId} type="button" role="option" aria-selected="false" className="map-vial-option" onClick={() => { setSelected(vial); setQuery(vial.vialId); setStatus(`Vial ${vial.vialId} selected.`); }}>
                <IdTag value={vial.vialId} icon="droplet-half" />
                <span className="nl-pill nl-pill-blood">{vial.bloodGroup || "—"}</span>
                <span className="text-secondary small">{vial.stockClassification === "KARYOTYPE_TESTED" ? "Karyotype tested" : "Normal stock"}</span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="map-vial-selected">
            <div className="d-flex flex-wrap align-items-center gap-2">
              <Icon name="check-circle-fill" className="text-success" />
              <IdTag value={selected.vialId} icon="droplet-half" />
              <span className="nl-pill nl-pill-blood">{selected.bloodGroup || "—"}</span>
              <span className="small text-secondary">{selected.stockClassification === "KARYOTYPE_TESTED" ? "Karyotype tested" : "Normal stock"}</span>
            </div>
            <div className="small mt-2">Will be mapped to case <strong>{couple.coupleId}</strong>.</div>
          </div>
        )}
      </form>
      <div className="alert alert-warning small mt-3 mb-0"><Icon name="exclamation-triangle" className="me-1" />Once mapped, this vial is treated as used and cannot be returned to stock.</div>
    </Modal>
  );
}

export default function CouplesPage() {
  const { user } = useSession();
  const hospital = user.role === "HOSPITAL_USER";
  const list = usePagedList("/couples");
  const [modal, setModal] = useState(null);
  const finish = () => { setModal(null); list.reload(); };

  return (
    <>
      <PageTitle count={list.pagination ? `${list.pagination.total} cases` : undefined} title="Couple cases" subtitle="Hospital-owned cases and vial mapping" action={hospital && <button className="btn btn-primary" type="button" onClick={() => setModal({ type: "new" })}><Icon name="plus-lg" className="me-1" />New couple case</button>} />
      <Alert message={list.error} />
      <div className="section-card">
        <DataTable headers={["Case ID", "Hospital", "Vials mapped", "Status", "Action"]} empty={list.loading ? "Loading cases…" : "No records yet"}>
          {list.records.map(couple => (
            <tr key={couple.coupleId}>
              <td><IdTag value={couple.coupleId} icon="people" /></td>
              <td>{couple.hospitalId || "—"}</td>
              <td>{(couple.mappedVialIds || []).length ? <div className="d-flex flex-wrap gap-1">{couple.mappedVialIds.map(vialId => <IdTag key={vialId} value={vialId} tone="slate" />)}</div> : <span className="text-secondary">None</span>}</td>
              <td><Badge status={couple.status} /></td>
              <td>
                <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setModal({ type: "view", couple })}>Open</button>{" "}
                {hospital && couple.status !== "MAPPED_USED" && <button className="btn btn-sm btn-primary" type="button" onClick={() => setModal({ type: "map", couple })}>Map vial</button>}
              </td>
            </tr>
          ))}
        </DataTable>
        <LoadMore list={list} label="cases" />
      </div>
      {modal?.type === "new" && <NewCoupleModal user={user} onClose={() => setModal(null)} onSaved={finish} />}
      {modal?.type === "view" && <CoupleDetailModal couple={modal.couple} mayViewIdentity={["HOSPITAL_USER", "SUPER_ADMIN"].includes(user.role)} onClose={() => setModal(null)} />}
      {modal?.type === "map" && <MapVialModal couple={modal.couple} onClose={() => setModal(null)} onSaved={finish} />}
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, DataTable, Field, Icon, IdTag, LoadMore, Modal, PageTitle, usePagedList } from "@/components/ui";
import { apiRequest, downloadAttachment } from "@/lib/api";
import { validUploadFile } from "@/lib/format";

const ID_TYPES = [{ value: "", label: "Select ID type (optional)" }, ...["Aadhaar", "Passport", "Voter ID", "Driving licence", "Other approved ID"].map(value => ({ value, label: value }))];
const EMPTY_FORM = { hName: "", hType: "", hNumber: "", wName: "", wType: "", wNumber: "" };

function PartnerFields({ prefix, title, form, setForm, setFile }) {
  const isAadhaar = form[`${prefix}Type`] === "Aadhaar";
  const fieldProps = { form, setForm };
  return (
    <>
      <h6 className="mb-3">{title}</h6>
      <div className="row g-3">
        <Field {...fieldProps} label="Full name" name={`${prefix}Name`} required />
        <Field {...fieldProps} label="Identity document type" name={`${prefix}Type`} choices={ID_TYPES} />
        <Field {...fieldProps} label="Identity document number" name={`${prefix}Number`} maxLength={isAadhaar ? 12 : 160} inputMode={isAadhaar ? "numeric" : "text"} pattern={isAadhaar ? "[0-9]{1,12}" : undefined} title={isAadhaar ? "Aadhaar numbers must contain no more than 12 digits." : undefined} />
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
      if (![husband, wife].some(person => person.idType === "Aadhaar" && person.idNumber)) return setError("Enter an Aadhaar number for at least one partner.");
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
      <p className="small text-secondary mt-3 mb-0">At least one partner&apos;s Aadhaar number is required (up to 12 digits). Supporting identity files are optional and are stored privately if uploaded.</p>
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

function MapVialModal({ couple, onClose, onSaved }) {
  const [vials, setVials] = useState([]);
  const [page, setPage] = useState({ skip: 0, hasMore: false, loading: true });
  const [vialId, setVialId] = useState("");
  const [status, setStatus] = useState("Loading eligible vials…");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (skip, existing) => {
    setPage(current => ({ ...current, loading: true }));
    setStatus("Loading eligible vials…");
    try {
      const result = await apiRequest(`/vials?${new URLSearchParams({ status: "UNUSED_AT_HOSPITAL", limit: "100", skip: String(skip) })}`);
      const records = [...existing, ...(result.data || [])];
      setVials(records);
      setPage({ skip: result.pagination ? result.pagination.skip + (result.data || []).length : skip + (result.data || []).length, hasMore: Boolean(result.pagination?.hasMore), loading: false });
      setStatus(records.length ? `${records.length} eligible vial${records.length === 1 ? "" : "s"} loaded.` : "No eligible vials are available for this hospital and centre.");
    } catch (loadError) {
      setPage(current => ({ ...current, hasMore: true, loading: false }));
      setStatus(loadError.message || "Unable to load eligible vials. Try again.");
    }
  }, []);

  useEffect(() => { load(0, []); }, [load]);

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await apiRequest("/mappings", { method: "POST", body: { coupleId: couple.coupleId, vialId } });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  return (
    <Modal title="Map vial to couple" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="mapForm" disabled={!vialId || saving}>{saving ? "Saving…" : "Confirm mapping"}</button>
    </>}>
      <Alert message={error} />
      <div className="alert alert-info">Mapping records the selected vial against this couple and updates its status through the hospital-scoped API.</div>
      <form id="mapForm" onSubmit={submit}>
        <div className="mb-3">
          <label className="form-label" htmlFor="mapVialId">Available vial</label>
          <select className="form-select" id="mapVialId" required disabled={!vials.length} value={vialId} onChange={event => setVialId(event.target.value)}>
            <option value="">{vials.length ? "Select an eligible vial" : "Loading eligible vials…"}</option>
            {vials.map(vial => <option key={vial.vialId} value={vial.vialId}>{[vial.vialId, vial.bloodGroup].filter(Boolean).join(" · ")}</option>)}
          </select>
        </div>
      </form>
      <div className="small text-secondary mb-2" aria-live="polite">{status}</div>
      {page.hasMore && <button type="button" className="btn btn-sm btn-outline-primary" disabled={page.loading} onClick={() => load(page.skip, vials)}>Load more eligible vials</button>}
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

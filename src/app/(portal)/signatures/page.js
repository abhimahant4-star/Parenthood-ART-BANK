"use client";

import { useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, DataTable, Field, LoadMore, Modal, PageTitle, usePagedList } from "@/components/ui";
import { apiRequest } from "@/lib/api";
import { validUploadFile } from "@/lib/format";

function SignerModal({ signer, onClose, onSaved }) {
  const [form, setForm] = useState({ name: signer?.name || "", designation: signer?.designation || "" });
  const [image, setImage] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (image && !validUploadFile(image, true)) return setError("Signature images must be PNG or JPG and no larger than 10 MB.");
    setSaving(true);
    const formData = new FormData();
    formData.append("name", form.name.trim());
    formData.append("designation", form.designation.trim());
    if (image) formData.append("signatureImage", image);
    try {
      await apiRequest(signer ? `/signers/${encodeURIComponent(signer.signerId)}` : "/signers", { method: signer ? "PUT" : "POST", formData });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  return (
    <Modal title={signer ? "Update authorised signatory" : "Add authorised signatory"} onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="signerForm" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </>}>
      <Alert message={error} />
      <form id="signerForm" className="row g-3" onSubmit={submit}>
        <Field form={form} setForm={setForm} label="Name" name="name" required />
        <Field form={form} setForm={setForm} label="Designation" name="designation" required />
        <div className="col-12">
          <label className="form-label" htmlFor="signerFile">Signature image (PNG/JPG, max 10 MB){signer ? " · optional replacement" : ""}</label>
          <input id="signerFile" className="form-control" type="file" accept=".png,.jpg,.jpeg" required={!signer} onChange={event => setImage(event.target.files[0] || null)} />
        </div>
      </form>
      <p className="small text-secondary mt-3 mb-0">Previous image versions remain available for declaration previews.</p>
    </Modal>
  );
}

export default function SignaturesPage() {
  const { user } = useSession();
  const superAdmin = user.role === "SUPER_ADMIN";
  const list = usePagedList("/signers");
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState("");

  const toggle = async signer => {
    setMessage("");
    try {
      await apiRequest(`/signers/${encodeURIComponent(signer.signerId)}/status`, { method: "PATCH", body: { status: signer.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" } });
      list.reload();
    } catch (error) { setMessage(error.message); }
  };

  return (
    <>
      <PageTitle title="Authorised signatures" subtitle="Super Admin manages a versioned private signer library" action={superAdmin && <button className="btn btn-primary" type="button" onClick={() => setModal({})}>Add signatory</button>} />
      <Alert message={message || list.error} />
      <div className="section-card">
        <DataTable headers={["Name", "Designation", "Version", "Status", "Actions"]} empty={list.loading ? "Loading signatories…" : "No records yet"}>
          {list.records.map(signer => (
            <tr key={signer.signerId}>
              <td className="fw-semibold">{signer.name}</td>
              <td>{signer.designation}</td>
              <td><span className="nl-count">v{signer.version}</span></td>
              <td><Badge status={signer.status === "ACTIVE" ? "Active" : "Inactive"} /></td>
              <td>{superAdmin && <>
                <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setModal({ signer })}>Edit</button>{" "}
                <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => toggle(signer)}>{signer.status === "ACTIVE" ? "Deactivate" : "Activate"}</button>
              </>}</td>
            </tr>
          ))}
        </DataTable>
        <LoadMore list={list} label="signatories" />
      </div>
      {modal && <SignerModal signer={modal.signer} onClose={() => setModal(null)} onSaved={() => { setModal(null); list.reload(); }} />}
    </>
  );
}

"use client";

import { useState } from "react";
import { Alert, Badge, DataTable, Field, IdTag, LoadMore, Modal, PageTitle, useLoader, usePagedList } from "@/components/ui";
import { apiRequest } from "@/lib/api";
import { roleLabel } from "@/lib/format";

const CREATE_ROLES = ["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "CHAIN_CEO"];

function scopeIdPreview(prefix, name) {
  const slug = String(name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `${prefix}-${slug}` : "";
}

function HospitalRegistrationModal({ ceos, onClose, onDone }) {
  const [form, setForm] = useState({ hospitalName: "", username: "", password: "", ceo: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (!form.ceo) return setError("Choose whether this hospital should be connected to a CEO account.");
    setSaving(true);
    try {
      const saved = await apiRequest("/users/hospital-registration", { method: "POST", body: { hospitalName: form.hospitalName.trim(), username: form.username.trim(), password: form.password, linkedCeoId: form.ceo === "NONE" ? null : form.ceo } });
      const ceo = ceos.find(item => item._id === form.ceo);
      setResult({ ...saved.data, ceoLabel: ceo ? `${ceo.name || ceo.username} (${ceo.username})` : "Not linked" });
    } catch (saveError) { setError(saveError.message); }
    finally { setSaving(false); }
  };

  if (result) {
    return (
      <Modal title="Register hospital" onClose={onDone} footer={<button className="btn btn-primary" type="button" onClick={onDone}>Done</button>}>
        <div className="alert alert-success">Hospital account registered successfully.</div>
        <dl className="row">
          <dt className="col-sm-4">Hospital</dt><dd className="col-sm-8">{result.hospitalName}</dd>
          <dt className="col-sm-4">Username / Login ID / Hospital ID</dt><dd className="col-sm-8"><code>{result.username}</code></dd>
          <dt className="col-sm-4">Centre ID</dt><dd className="col-sm-8"><code>{result.centreId}</code></dd>
          <dt className="col-sm-4">CEO connection</dt><dd className="col-sm-8">{result.ceoLabel}</dd>
        </dl>
        <p className="small text-secondary mb-0">Use this username as the hospital&apos;s Login ID and Hospital ID. The Centre ID is based on the username.</p>
      </Modal>
    );
  }

  const fieldProps = { form, setForm, col: "col-12" };
  return (
    <Modal title="Register hospital" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="hospitalRegistrationForm" disabled={saving}>{saving ? "Saving…" : "Register hospital"}</button>
    </>}>
      <Alert message={error} />
      <form id="hospitalRegistrationForm" className="row g-3" onSubmit={submit}>
        <Field {...fieldProps} label="Hospital name" name="hospitalName" maxLength={160} required />
        <Field {...fieldProps} label="Username / Hospital ID (Login ID)" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,63}" title="Use 3-64 letters, numbers, dots, underscores or hyphens; start with a letter or number." required />
        <Field {...fieldProps} label="Password" name="password" type="password" autoComplete="new-password" required />
        <Field {...fieldProps} label="Connect to a CEO account?" name="ceo" required hint="When connected, only the selected CEO can view this hospital's name, stock, orders and dispatch status. Patient, couple and declaration details remain private." choices={[{ value: "", label: "Choose whether to connect" }, { value: "NONE", label: "Do not connect to a CEO" }, ...ceos.map(ceo => ({ value: ceo._id, label: `${ceo.name || ceo.username} (${ceo.username})` }))]} />
      </form>
      <p className="small text-secondary mt-3">The username is also the hospital&apos;s Login ID and Hospital ID. Centre ID is generated from the username (CENTRE-&lt;username&gt;). Duplicate usernames and hospital names are rejected.</p>
    </Modal>
  );
}

function UserModal({ existing, hospitals, onClose, onSaved }) {
  const editing = Boolean(existing);
  const legacyScope = editing && (!existing.hospitalName || !existing.centreName);
  const [form, setForm] = useState({
    name: existing?.name || "", username: existing?.username || "", password: "", role: existing?.role || "",
    hospitalName: existing?.hospitalName || "", centreName: existing?.centreName || "", chainId: existing?.chainId || ""
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const hospitalUser = form.role === "HOSPITAL_USER";
  const keepingLegacyScope = legacyScope && !form.hospitalName.trim() && !form.centreName.trim();
  const knownHospital = hospitals.find(item => (item.hospitalName || item.name).toLowerCase() === form.hospitalName.trim().toLowerCase());
  const centres = knownHospital?.centres || [];
  const knownCentre = centres.find(item => (item.centreName || item.name).toLowerCase() === form.centreName.trim().toLowerCase());
  const hospitalIdPreview = form.hospitalName.trim() ? knownHospital?.hospitalId || scopeIdPreview("HOSP", form.hospitalName) : existing?.hospitalId || "";
  const centreIdPreview = form.centreName.trim() ? knownCentre?.centreId || scopeIdPreview("CENTRE", form.centreName) : existing?.centreId || "";

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    const body = {
      name: form.name.trim(), role: form.role,
      hospitalId: hospitalUser && keepingLegacyScope ? hospitalIdPreview : undefined,
      centreId: hospitalUser && keepingLegacyScope ? centreIdPreview : undefined,
      hospitalName: hospitalUser && !keepingLegacyScope ? form.hospitalName.trim() : undefined,
      centreName: hospitalUser && !keepingLegacyScope ? form.centreName.trim() : undefined,
      chainId: form.role === "CHAIN_CEO" ? form.chainId.trim() : undefined
    };
    try {
      if (editing) await apiRequest(`/users/${encodeURIComponent(existing._id)}`, { method: "PUT", body });
      else await apiRequest("/users", { method: "POST", body: { ...body, username: form.username.trim(), password: form.password } });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  const roles = editing ? [...CREATE_ROLES, "HOSPITAL_USER"] : CREATE_ROLES;
  const fieldProps = { form, setForm };
  const scopeRequired = hospitalUser && !keepingLegacyScope;
  return (
    <Modal title={editing ? "Edit hospital user scope" : "Create user"} onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="userForm" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Create account"}</button>
    </>}>
      <Alert message={error} />
      <form id="userForm" className="row g-3" onSubmit={submit}>
        <Field {...fieldProps} label="Full name" name="name" required />
        <Field {...fieldProps} label="Username" name="username" required disabled={editing} />
        {!editing && <Field {...fieldProps} label="Temporary password" name="password" type="password" required autoComplete="new-password" />}
        <Field {...fieldProps} label="Role" name="role" required disabled={editing} choices={[{ value: "", label: "Select role" }, ...roles]} />
        <div className="col-md-6">
          <label className="form-label" htmlFor="userHospital">Full hospital name</label>
          <input className="form-control" id="userHospital" list="knownHospitals" autoComplete="off" required={scopeRequired} value={form.hospitalName} onChange={event => setForm(current => ({ ...current, hospitalName: event.target.value }))} />
          <datalist id="knownHospitals">{hospitals.map(item => <option key={item.hospitalId} value={item.hospitalName || item.name} />)}</datalist>
          <label className="form-label mt-2" htmlFor="userHospitalId">Assigned Hospital ID</label>
          <input className="form-control" id="userHospitalId" readOnly value={hospitalIdPreview} />
        </div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="userCentre">Full centre name</label>
          <input className="form-control" id="userCentre" list="knownCentres" autoComplete="off" required={scopeRequired} value={form.centreName} onChange={event => setForm(current => ({ ...current, centreName: event.target.value }))} />
          <datalist id="knownCentres">{centres.map(item => <option key={item.centreId} value={item.centreName || item.name} />)}</datalist>
          <label className="form-label mt-2" htmlFor="userCentreId">Assigned Centre ID</label>
          <input className="form-control" id="userCentreId" readOnly value={centreIdPreview} />
        </div>
        <Field {...fieldProps} label="Chain ID (Chain CEO only)" name="chainId" />
      </form>
      <p className="small text-secondary mt-3">Enter the full hospital and centre names. IDs are assigned automatically and shared by users with matching names. Legacy scopes remain unchanged until their names are recorded. Changing scope revokes this user&apos;s current session.</p>
    </Modal>
  );
}

export default function UsersPage() {
  const list = usePagedList("/users");
  const hospitals = useLoader(async () => (await apiRequest("/hospitals")).data || [], []);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState("");

  const finish = () => { setModal(null); list.reload(); hospitals.reload(); };
  const registerHospital = async () => {
    setMessage("");
    try { setModal({ type: "hospital", ceos: (await apiRequest("/users/ceos")).data || [] }); }
    catch (error) { setMessage(error.message); }
  };
  const setActive = async (account, active) => {
    setMessage("");
    try {
      await apiRequest(`/users/${encodeURIComponent(account._id)}`, { method: "PUT", body: { active } });
      list.reload();
    } catch (error) { setMessage(error.message); }
  };

  return (
    <>
      <PageTitle count={list.pagination ? `${list.pagination.total} users` : undefined} title="User management" subtitle="Create accounts with explicit hospital and centre assignments" action={<div>
        <button className="btn btn-outline-primary me-2" type="button" onClick={registerHospital}>Register hospital</button>
        <button className="btn btn-primary" type="button" onClick={() => setModal({ type: "user" })}>Create user</button>
      </div>} />
      <Alert message={message || list.error} />
      <div className="section-card">
        <DataTable headers={["Name", "Username", "Role", "Data scope", "Status", "Action"]} empty={list.loading ? "Loading users…" : "No records yet"}>
          {list.records.map(account => (
            <tr key={account._id}>
              <td className="fw-semibold">{account.name || ""}</td>
              <td><IdTag value={account.username} icon="person" tone="slate" /></td>
              <td><span className="nl-pill nl-pill-role">{roleLabel(account.role)}</span></td>
              <td>{account.hospitalId ? <span className="nl-mono">{account.hospitalId} / {account.centreId || "Unassigned"}</span> : <span className="text-secondary">{account.chainId || "Global"}</span>}</td>
              <td><Badge status={account.active ? "ACTIVE" : "INACTIVE"} /></td>
              <td className="d-flex gap-2">
                {account.role === "HOSPITAL_USER" && <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setModal({ type: "user", existing: account })}>Edit scope</button>}
                <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => setActive(account, !account.active)}>{account.active ? "Deactivate" : "Activate"}</button>
              </td>
            </tr>
          ))}
        </DataTable>
        <LoadMore list={list} label="users" />
      </div>
      {modal?.type === "hospital" && <HospitalRegistrationModal ceos={modal.ceos} onClose={() => setModal(null)} onDone={finish} />}
      {modal?.type === "user" && <UserModal existing={modal.existing} hospitals={hospitals.data || []} onClose={() => setModal(null)} onSaved={finish} />}
    </>
  );
}

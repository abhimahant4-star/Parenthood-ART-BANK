"use client";

import { useState } from "react";
import { Alert, DataTable, Icon, LoadMore, Modal, PageTitle, useLoader, usePagedList } from "@/components/ui";
import { apiRequest, downloadFile } from "@/lib/api";
import { roleLabel } from "@/lib/format";

const EMPTY = { action: "", role: "", entity: "", from: "", to: "" };
const ROLES = ["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER", "CHAIN_CEO"];
const extractLogs = result => result.data?.logs || [];
const readable = value => String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase().replace(/^./, letter => letter.toUpperCase());

function AuditDetailModal({ entry, onClose }) {
  const rows = [
    ["Time", entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "—"],
    ["Action", entry.action], ["User ID", entry.userId || "system"], ["Role", entry.role ? roleLabel(entry.role) : "—"],
    ["Entity", entry.entity || "—"], ["Entity ID", entry.entityId || "—"], ["IP address", entry.ip || "—"],
    ...Object.entries(entry.newValues || {}).map(([key, value]) => [readable(key), String(value)])
  ];
  return (
    <Modal title="Audit event" onClose={onClose} footer={<button className="btn btn-light" type="button" onClick={onClose}>Close</button>}>
      <DataTable headers={["Field", "Value"]}>
        {rows.map(([label, value]) => <tr key={label}><td className="text-secondary">{label}</td><td>{value}</td></tr>)}
      </DataTable>
      <p className="small text-secondary mt-3 mb-0">Sensitive values such as Aadhaar numbers and passwords are never stored in the audit trail.</p>
    </Modal>
  );
}

export default function AuditPage() {
  const [draft, setDraft] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [message, setMessage] = useState("");
  const [inspecting, setInspecting] = useState(null);
  const list = usePagedList("/audit", applied, extractLogs);
  const options = useLoader(async () => (await apiRequest("/audit/options")).data, []);
  const set = key => event => setDraft(current => ({ ...current, [key]: event.target.value }));

  const apply = () => {
    setMessage("");
    if (draft.from && draft.to && draft.from > draft.to) return setMessage("Start date must be on or before end date.");
    setApplied({ ...draft });
  };
  const clear = () => { setMessage(""); setDraft(EMPTY); setApplied(EMPTY); };
  const exportCsv = () => {
    setMessage("");
    const params = new URLSearchParams(Object.entries(applied).filter(([, value]) => value));
    downloadFile(`/audit/export.csv${params.size ? `?${params}` : ""}`, "audit-trail.csv").catch(error => setMessage(error.message));
  };

  return (
    <>
      <PageTitle count={list.pagination ? `${list.pagination.total} events logged` : undefined} title="Regulatory Immutable Audit Trail" subtitle="Tamper-evident record of logins, releases, dispatches, mappings and declarations" action={
        <button className="btn btn-outline-primary nl-btn-export" type="button" onClick={exportCsv}><Icon name="download" className="me-1" />Export CSV</button>
      } />
      <Alert message={message || list.error || options.error} />
      <div className="section-card report-filter-card audit-filter-card mb-4">
        <div className="report-filter-row audit-filter-row">
          <label>Action
            <select className="form-select" value={draft.action} onChange={set("action")}>
              <option value="">All actions</option>
              {(options.data?.actions || []).map(action => <option key={action} value={action}>{readable(action)}</option>)}
            </select>
          </label>
          <label>Role
            <select className="form-select" value={draft.role} onChange={set("role")}>
              <option value="">All roles</option>
              {ROLES.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
            </select>
          </label>
          <label>Entity
            <select className="form-select" value={draft.entity} onChange={set("entity")}>
              <option value="">All entities</option>
              {(options.data?.entities || []).map(entity => <option key={entity} value={entity}>{readable(entity)}</option>)}
            </select>
          </label>
          <label>From<input className="form-control" type="date" value={draft.from} onChange={set("from")} /></label>
          <label>To<input className="form-control" type="date" value={draft.to} onChange={set("to")} /></label>
          <button className="btn btn-primary" type="button" onClick={apply}>Filter</button>
          <button className="btn btn-outline-secondary" type="button" onClick={clear}>Clear</button>
        </div>
        <div className="small text-secondary mt-2">The CSV export uses the filters currently applied. Each export is itself recorded in the audit trail.</div>
      </div>
      <div className="section-card audit-table-card">
        <DataTable headers={["Time", "User", "Role", "Action", "Entity", "Summary", ""]} empty={list.loading ? "Loading audit events…" : "No audit actions recorded"}>
          {list.records.map((entry, index) => (
            <tr key={entry._id || index}>
              <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : ""}</td>
              <td>{entry.username || entry.userId || "system"}</td>
              <td>{entry.role ? roleLabel(entry.role) : "—"}</td>
              <td><span className="nl-pill nl-pill-action">{entry.action}</span></td>
              <td><div className="fw-semibold">{readable(entry.entity) || "—"}</div>{entry.entityId && <div className="nl-mono-muted">{entry.entityId}</div>}</td>
              <td>{entry.summary}</td>
              <td><button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setInspecting(entry)}>Inspect</button></td>
            </tr>
          ))}
        </DataTable>
        <LoadMore list={list} label="audit events" />
      </div>
      {inspecting && <AuditDetailModal entry={inspecting} onClose={() => setInspecting(null)} />}
    </>
  );
}

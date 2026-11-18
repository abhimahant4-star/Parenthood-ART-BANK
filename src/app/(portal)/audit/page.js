"use client";

import { useState } from "react";
import { Alert, DataTable, LoadMore, PageTitle, usePagedList } from "@/components/ui";

const EMPTY = { action: "", role: "", entity: "", from: "", to: "" };
const extractLogs = result => result.data?.logs || [];

export default function AuditPage() {
  const [draft, setDraft] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [message, setMessage] = useState("");
  const list = usePagedList("/audit", applied, extractLogs);
  const set = key => event => setDraft(current => ({ ...current, [key]: event.target.value }));

  const apply = () => {
    setMessage("");
    if (draft.from && draft.to && draft.from > draft.to) return setMessage("Start date must be on or before end date.");
    setApplied({ ...draft, action: draft.action.trim(), entity: draft.entity.trim() });
  };
  const clear = () => { setMessage(""); setDraft(EMPTY); setApplied(EMPTY); };

  return (
    <>
      <PageTitle title="Audit activity" subtitle="Backend audit records" />
      <Alert message={message || list.error} />
      <div className="section-card report-filter-card audit-filter-card mb-4">
        <div className="report-filter-row audit-filter-row">
          <label>Action<input className="form-control" placeholder="Exact action" value={draft.action} onChange={set("action")} /></label>
          <label>Role
            <select className="form-select" value={draft.role} onChange={set("role")}>
              <option value="">All roles</option><option>SUPER_ADMIN</option><option>ART_BANK_ADMIN</option>
            </select>
          </label>
          <label>Entity<input className="form-control" placeholder="Exact entity" value={draft.entity} onChange={set("entity")} /></label>
          <label>From<input className="form-control" type="date" value={draft.from} onChange={set("from")} /></label>
          <label>To<input className="form-control" type="date" value={draft.to} onChange={set("to")} /></label>
          <button className="btn btn-primary" type="button" onClick={apply}>Filter</button>
          <button className="btn btn-outline-secondary" type="button" onClick={clear}>Clear</button>
        </div>
        <div className="small text-secondary mt-2">Filters use exact audit fields and a date range.</div>
      </div>
      <div className="section-card audit-table-card">
        <DataTable headers={["Time", "User", "Action", "Entity", "Summary"]} empty={list.loading ? "Loading audit events…" : "No audit actions recorded"}>
          {list.records.map((entry, index) => (
            <tr key={entry._id || index}>
              <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : ""}</td>
              <td>{entry.username || entry.userId || "system"}</td>
              <td>{entry.action}</td>
              <td>{entry.entity || ""}{entry.entityId ? ` · ${entry.entityId}` : ""}</td>
              <td>{entry.summary}</td>
            </tr>
          ))}
        </DataTable>
        <LoadMore list={list} label="audit events" />
      </div>
    </>
  );
}

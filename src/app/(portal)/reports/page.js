"use client";

import { useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Alert, DataTable, PageTitle, useLoader } from "@/components/ui";
import { apiRequest, downloadFile } from "@/lib/api";
import { BLOOD_GROUPS, canOperateBank } from "@/lib/format";

const dateQuery = ({ from, to }) => {
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  return query.size ? `?${query}` : "";
};

export default function ReportsPage() {
  const { user } = useSession();
  const bank = canOperateBank(user), hospital = user.role === "HOSPITAL_USER", ceo = user.role === "CHAIN_CEO";
  const [draft, setDraft] = useState({ from: "", to: "" });
  const [applied, setApplied] = useState({ from: "", to: "" });
  const [message, setMessage] = useState("");
  const [bloodGroup, setBloodGroup] = useState("");
  const report = useLoader(async () => (await apiRequest(`/reports${dateQuery(applied)}`)).data, [applied]);

  const summary = Object.entries(report.data?.summary || {})
    .filter(([key]) => key !== "signatures")
    .map(([key, value]) => [key[0].toUpperCase() + key.slice(1), value ?? "—"]);

  const apply = () => {
    setMessage("");
    if (draft.from && draft.to && draft.from > draft.to) return setMessage("Start date must be on or before end date.");
    setApplied({ ...draft });
  };
  const clear = () => {
    setMessage("");
    setDraft({ from: "", to: "" });
    setApplied({ from: "", to: "" });
  };
  const download = (path, filename) => {
    setMessage("");
    downloadFile(path, filename).catch(error => setMessage(error.message));
  };
  const query = dateQuery(applied);
  const bloodQuery = bloodGroup ? `?${new URLSearchParams({ bloodGroup })}` : "";

  return (
    <>
      <PageTitle title="Regulatory Reports & Data Exports" count="Audited records" subtitle="Standardised reports for the ART Bank, hospital partners and regulatory inspections, with CSV exports" />
      <Alert message={message || report.error} />
      <div className="section-card report-filter-card reports-filter-card mb-4">
        <div className="report-filter-row">
          <label>From<input className="form-control" type="date" value={draft.from} onChange={event => setDraft(current => ({ ...current, from: event.target.value }))} /></label>
          <label>To<input className="form-control" type="date" value={draft.to} onChange={event => setDraft(current => ({ ...current, to: event.target.value }))} /></label>
          <button className="btn btn-primary" type="button" onClick={apply}>Apply date range</button>
          <button className="btn btn-outline-secondary" type="button" onClick={clear}>Clear</button>
        </div>
        <div className="small text-secondary mt-2">The date range filters summary counts, order exports, and detailed couple/patient exports. Stock CSV is a current inventory snapshot.</div>
      </div>
      <div className="row g-3 mb-4 reports-summary">
        {summary.map(([label, value]) => <div className="col-6 col-xl-3" key={label}><div className="stat-card"><div className="stat-value">{value}</div><div className="stat-label">{label}</div></div></div>)}
      </div>
      <div className="section-card reports-table-card">
        <div className="card-head flex-wrap gap-2">
          <strong>Available reports</strong>
          {bank && (
            <select className="form-select ms-auto" style={{ maxWidth: 220 }} value={bloodGroup} onChange={event => setBloodGroup(event.target.value)} aria-label="Blood group for register reports">
              <option value="">All blood groups</option>{BLOOD_GROUPS.map(group => <option key={group}>{group}</option>)}
            </select>
          )}
        </div>
        <DataTable headers={["Report", "Data scope", "Format", "Download"]} empty="Aggregate chain reports are unavailable until hospital-to-chain scope is configured.">
          {(bank || hospital) && (
            <tr><td>Vial stock</td><td>Role-scoped inventory; hospital accounts see their assigned centre</td><td>CSV</td>
              <td><button className="btn btn-sm btn-outline-primary" type="button" onClick={() => download("/reports/stock.csv", "art-bank-stock.csv")}>Download</button></td></tr>
          )}
          {!ceo && (
            <tr><td>Orders, dispatch and receipt</td><td>Role-scoped order history</td><td>CSV, PDF</td>
              <td>
                <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => download(`/reports/export/csv${query}`, "art-bank-orders-report.csv")}>CSV</button>{" "}
                <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => download(`/reports/export/pdf${query}`, "art-bank-orders-report.pdf")}>PDF</button>
              </td></tr>
          )}
          {bank && (
            <>
              <tr><td>Complete donor registry</td><td>UHID, donor ID, demographics, batches, vials and screening results; filtered by blood group</td><td>CSV</td>
                <td><button className="btn btn-sm btn-outline-primary" type="button" onClick={() => download(`/reports/donors.csv${bloodQuery}`, "donor-registry.csv")}>Download</button></td></tr>
              <tr><td>6-month quarantine ledger</td><td>Every batch with quarantine dates, days remaining and release status; filtered by blood group</td><td>CSV</td>
                <td><button className="btn btn-sm btn-outline-primary" type="button" onClick={() => download(`/reports/quarantine.csv${bloodQuery}`, "quarantine-ledger.csv")}>Download</button></td></tr>
              <tr><td>Utilization and mapping</td><td>Used vials with hospital, couple case and mapping date; filtered by blood group</td><td>CSV</td>
                <td><button className="btn btn-sm btn-outline-primary" type="button" onClick={() => download(`/reports/utilization.csv${bloodQuery}`, "utilization-mapping.csv")}>Download</button></td></tr>
            </>
          )}
          {user.role === "SUPER_ADMIN" && (
            <tr><td>Couples and patients</td><td>Detailed identity export; Super Admin only</td><td>CSV</td>
              <td><button className="btn btn-sm btn-outline-danger" type="button" onClick={() => download(`/reports/export/couples${query}`, "couples-patients.csv")}>Download</button></td></tr>
          )}
        </DataTable>
      </div>
      <p className="small text-secondary mt-3">Exports are generated by the backend and recorded in its audit log. Hospital accounts receive only their assigned centre&apos;s stock and order data.</p>
    </>
  );
}

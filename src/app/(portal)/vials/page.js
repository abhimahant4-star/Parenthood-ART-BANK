"use client";

import { useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, BloodPill, DataTable, Icon, IdTag, Modal, PageTitle, StockPill, statusLabel, useLoader, usePagedList } from "@/components/ui";
import { loadAll } from "@/lib/api";
import { RecordActions, useRecordModals } from "@/components/RecordActions";
import { BLOOD_GROUPS, normalizeBloodGroup } from "@/lib/format";

const ALL_STATUSES = ["CREATED", "QUARANTINED", "RELEASED", "AVAILABLE_AT_ART_BANK", "DISPATCHED", "UNUSED_AT_HOSPITAL", "RETURNED_BEFORE_MAPPING", "MAPPED_USED", "BLOCKED", "RECALLED", "DISCARDED", "EXPIRED"];
const EMPTY_FILTERS = { q: "", status: "", bloodGroup: "", stockClassification: "", location: "" };

function CompactId({ value, kind }) {
  const [visible, setVisible] = useState(false);
  const text = String(value || "");
  const preview = text.length > 24 ? `${text.slice(0, 18)}...${text.slice(-4)}` : text;
  const label = `${visible ? "Hide" : "Show"} full ${kind} ID`;
  return (
    <div className={`compact-id-cell ${visible ? "is-visible" : ""}`}>
      <span className="compact-id-preview" title={text}>{preview}</span>
      <button className="compact-id-toggle" type="button" aria-label={label} aria-expanded={visible} title={label} onClick={() => setVisible(current => !current)}>
        <Icon name={visible ? "eye-slash" : "eye"} />
      </button>
      <span className="compact-id-full" aria-live="polite">{text}</span>
    </div>
  );
}

const calendarDate = value => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "";
};

// Movement history: Super Admin only (the server sends it to no other role).
function VialHistoryModal({ vial, onClose }) {
  const details = [["Vial ID", vial.vialId], ["Donor UHID", vial.donorUhid || vial.donorId], ["Batch ID", vial.batchId], ["Current location", vial.currentLocation], ["Status", statusLabel(vial.status)]];
  const history = vial.statusHistory || [];
  return (
    <Modal title={`Vial ${vial.vialId} history`} onClose={onClose}>
      <section className="vial-history-summary row g-3 mb-4" aria-label="Vial details">
        {details.map(([label, value]) => <div className="col-sm-6" key={label}><div className="vial-history-field"><div className="detail-label">{label}</div><div className="detail-value">{value || "—"}</div></div></div>)}
      </section>
      <div className="vial-history-heading">
        <span className="vial-history-heading-icon"><Icon name="clock-history" /></span>
        <span><strong>Custody and status history</strong><small>{history.length} recorded event{history.length === 1 ? "" : "s"}</small></span>
      </div>
      <ul className="vial-history-timeline" aria-label="Vial status events">
        {history.length ? history.map((event, index) => {
          const valid = event.at && !Number.isNaN(new Date(event.at).getTime());
          // Quarantine dates are calendar days (stored as UTC midnight), so show the date only.
          const quarantine = event.status === "QUARANTINED";
          const when = !valid ? "Time unavailable" : quarantine
            ? `From ${calendarDate(event.at)}${calendarDate(event.quarantineEnd) ? ` to ${calendarDate(event.quarantineEnd)}` : ""}`
            : new Date(event.at).toLocaleString();
          return (
            <li className="vial-history-event" key={`${event.status}-${index}`}>
              <div className="vial-history-event-status"><Badge status={event.status} /></div>
              <div className="vial-history-event-meta">
                <time>{when}</time>
                <span>{event.user || event.by || event.dispatchedBy || event.receivedBy || "system"}</span>
                {event.coupleId && <span>Case {event.coupleId}</span>}
                {event.orderId && <span>Order {event.orderId}</span>}
              </div>
            </li>
          );
        }) : <li className="vial-history-empty"><Icon name="info-circle" />No status changes have been recorded yet.</li>}
      </ul>
    </Modal>
  );
}

export default function VialsPage() {
  const { user } = useSession();
  const isHospital = user.role === "HOSPITAL_USER", ceo = user.role === "CHAIN_CEO";
  const superAdmin = user.role === "SUPER_ADMIN";
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [history, setHistory] = useState(null);
  const list = usePagedList("/vials", { ...filters, q: filters.q.trim() });
  const extras = useLoader(() => loadAll({ stock: "/stock", hospitals: ceo ? "/hospitals" : null }), [ceo]);
  const records = useRecordModals(() => { list.reload(); extras.reload(); });

  const stock = extras.data?.results.stock?.data;
  const hospitals = extras.data?.results.hospitals?.data || [];
  const hospitalName = id => hospitals.find(item => item.hospitalId === id)?.hospitalName || id || "—";
  const counts = new Map((stock?.byStatus || []).map(item => [item.status, item.count]));
  const count = (...statuses) => statuses.reduce((total, status) => total + (counts.get(status) || 0), 0);
  const inventoryTotal = stock?.total ?? list.pagination?.total ?? list.records.length;
  const stats = isHospital
    ? [["Vials in your scope", inventoryTotal], ["Unused hospital stock", count("UNUSED_AT_HOSPITAL")], ["Mapped / used", count("MAPPED_USED")]]
    : ceo
      ? [["Vials in linked hospitals", inventoryTotal], ["Dispatched", count("DISPATCHED")], ["Unused hospital stock", count("UNUSED_AT_HOSPITAL")], ["Mapped / used", count("MAPPED_USED")]]
      : [["Vials in scope", inventoryTotal], ["Available at ART Bank", count("RELEASED", "AVAILABLE_AT_ART_BANK")], ["At hospitals", count("DISPATCHED", "UNUSED_AT_HOSPITAL")], ["Mapped / used", count("MAPPED_USED")]];
  const statuses = ALL_STATUSES.filter(status => !isHospital || !["CREATED", "QUARANTINED", "RELEASED", "AVAILABLE_AT_ART_BANK"].includes(status));
  const locations = [...new Set([...list.records.map(vial => vial.currentLocation), filters.location].filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  const columns = isHospital ? ["Vial ID", "Blood group", "Location", "Status"] : ceo ? ["Vial ID", "Hospital", "Centre", "Blood group", "Stock type", "Location", "Status"] : ["Vial ID", "Donor UHID", "Batch ID", "Blood group", "Stock type", "Location", "Status", ...(superAdmin ? ["Action"] : [])];
  const setFilter = key => event => setFilters(current => ({ ...current, [key]: event.target.value }));

  return (
    <>
      <PageTitle count={`${inventoryTotal} vials tracked`} title={isHospital ? "My Stock" : ceo ? "Linked hospital stock" : "Vial inventory"} subtitle={isHospital ? "Vial inventory in your hospital scope" : ceo ? "Operational vial records for linked hospital accounts" : "Individual vial records, classification and movement history"} />
      <Alert message={list.error} />
      <div className="row g-3 mb-4">
        {stats.map(([label, value]) => <div className={`col-6 col-xl-${isHospital ? 4 : 3}`} key={label}><div className="stat-card compact-stat"><div className="stat-label">{label}</div><div className="stat-value">{value}</div></div></div>)}
      </div>
      <div className="section-card inventory-card">
        <div className="inventory-toolbar">
          <div className="inventory-heading">
            <strong>{isHospital ? "Hospital Vial Inventory" : ceo ? "Linked Hospital Vial Inventory" : "Individual Vial Inventory & Movement Ledger"}</strong>
            <span className="inventory-count">{list.records.length} loaded · {list.pagination?.total ?? list.records.length} matching</span>
          </div>
          <div className="inventory-filters">
            <label className="inventory-search"><Icon name="search" /><input type="search" className="form-control" placeholder={isHospital || ceo ? "Search vial or location" : "Search vial, donor UHID, batch or location"} aria-label="Search vial inventory" value={filters.q} onChange={setFilter("q")} /></label>
            <select className="form-select" aria-label="Filter by status" value={filters.status} onChange={setFilter("status")}>
              <option value="">All statuses</option>{statuses.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select>
            <select className="form-select" aria-label="Filter by blood group" value={filters.bloodGroup} onChange={setFilter("bloodGroup")}>
              <option value="">All blood groups</option>{BLOOD_GROUPS.map(group => <option key={group} value={group}>{group}</option>)}
            </select>
            {!isHospital && (
              <select className="form-select" aria-label="Filter by stock type" value={filters.stockClassification} onChange={setFilter("stockClassification")}>
                <option value="">All stock types</option><option value="KARYOTYPE_TESTED">Karyotype tested</option><option value="NORMAL_STOCK">Normal stock</option><option value="__UNSPECIFIED__">Not specified</option>
              </select>
            )}
            <select className="form-select" aria-label="Filter by location" value={filters.location} onChange={setFilter("location")}>
              <option value="">All locations</option>{locations.map(location => <option key={location} value={location}>{location}</option>)}
            </select>
            <button className="btn btn-outline-secondary clear-inventory-filters" type="button" onClick={() => setFilters(EMPTY_FILTERS)}><Icon name="arrow-counterclockwise" className="me-1" />Clear</button>
          </div>
        </div>
        <div className="inventory-table-wrap">
          <DataTable headers={columns} empty={list.loading ? "Loading vials…" : "No vials match these filters."}>
            {list.records.map(vial => {
              const blood = <BloodPill value={normalizeBloodGroup(vial.bloodGroup)} />;
              const id = String(vial.vialId).length > 24 ? <CompactId value={vial.vialId} kind="vial" /> : <IdTag value={vial.vialId} icon="droplet-half" />;
              const stockType = <StockPill value={vial.stockClassification} />;
              if (isHospital) return <tr key={vial.vialId}><td>{id}</td><td>{blood}</td><td>{vial.currentLocation || "—"}</td><td><Badge status={vial.status} /></td></tr>;
              if (ceo) return <tr key={vial.vialId}><td>{id}</td><td>{hospitalName(vial.hospitalId)}</td><td>{vial.centreId || "—"}</td><td>{blood}</td><td>{stockType}</td><td>{vial.currentLocation || "—"}</td><td><Badge status={vial.status} /></td></tr>;
              return (
                <tr key={vial.vialId}>
                  <td>{id}</td><td><IdTag value={vial.donorUhid || vial.donorId} icon="fingerprint" /></td><td>{String(vial.batchId).length > 24 ? <CompactId value={vial.batchId} kind="batch" /> : <IdTag value={vial.batchId} icon="layers" tone="slate" />}</td><td>{blood}</td>
                  <td>{stockType}</td><td>{vial.currentLocation || "—"}</td><td><Badge status={vial.status} /></td>
                  {superAdmin && (
                    <td>
                      <div className="d-flex align-items-center gap-2">
                        <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setHistory(vial)}><Icon name="clock-history" className="me-1" />History</button>
                        <RecordActions label={`vial ${vial.vialId}`} onEdit={() => records.open("editVial", vial)} onDelete={() => records.open("deleteVial", vial)} />
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </DataTable>
        </div>
        <div className="d-flex justify-content-between align-items-center p-3">
          <span className="small text-secondary">Search and filters apply across your access scope.</span>
          {list.hasMore
            ? <button className="btn btn-outline-primary" type="button" disabled={list.loadingMore} onClick={list.loadMore}>{list.loadingMore ? "Loading…" : `Load next ${list.pagination.limit}`}</button>
            : <span className="small text-secondary">All {list.pagination?.total ?? list.records.length} records loaded</span>}
        </div>
      </div>
      {records.element}
      {history && <VialHistoryModal vial={history} onClose={() => setHistory(null)} />}
    </>
  );
}

"use client";

import Link from "next/link";
import { useSession } from "@/components/SessionProvider";
import { DataTable, Icon, LoadErrors, useLoader } from "@/components/ui";
import { loadAll } from "@/lib/api";
import { RecordActions, useRecordModals } from "@/components/RecordActions";
import { VIAL_STATUS_LABELS, VIAL_STATUS_TONES, canOperateBank, compactId, normalizeBloodGroup } from "@/lib/format";

function jobsFor(role) {
  if (role === "HOSPITAL_USER") return { vials: "/vials", stock: "/stock", reports: "/reports", orders: "/orders", couples: "/couples", declarations: "/declarations" };
  if (role === "CHAIN_CEO") return { hospitals: "/hospitals", vials: "/vials", stock: "/stock", orders: "/orders", reports: "/reports" };
  return { donors: "/donors", batches: "/batches", vials: "/vials", stock: "/stock", reports: "/reports", orders: "/orders", declarations: "/declarations" };
}

function VialStatus({ status }) {
  return <span className={`activity-status ${VIAL_STATUS_TONES[status] || "gray"}`}><i />{VIAL_STATUS_LABELS[status] || "Status unavailable"}</span>;
}

function VialId({ id }) {
  return <span className="activity-id" title={id}>{compactId(id)}</span>;
}

function BloodGroup({ value }) {
  return <span className="blood-group-pill">{normalizeBloodGroup(value) || "—"}</span>;
}

function Shortcut({ href, icon, title, text, primary }) {
  return (
    <Link href={href} className={`dashboard-action ${primary ? "primary" : ""}`}>
      <span className="dashboard-action-icon"><Icon name={icon} /></span>
      <span><strong>{title}</strong><small>{text}</small></span>
      <Icon name="arrow-up-right" className="action-arrow" />
    </Link>
  );
}

export default function DashboardPage() {
  const { user } = useSession();
  const { data, reload } = useLoader(() => loadAll(jobsFor(user.role)), [user.role]);
  const superAdmin = user.role === "SUPER_ADMIN";
  const records = useRecordModals(reload);
  const results = data?.results || {};
  const bank = canOperateBank(user), hospital = user.role === "HOSPITAL_USER", ceo = user.role === "CHAIN_CEO";

  const vials = results.vials?.data || [];
  const hospitals = results.hospitals?.data || [];
  const stockData = results.stock?.data;
  const stockByStatus = new Map((stockData?.byStatus || []).map(item => [item.status, item.count]));
  const statusCount = (...statuses) => statuses.reduce((total, status) => total + (stockByStatus.get(status) || 0), 0);
  const stockTotal = stockData?.total ?? vials.length;
  const summary = results.reports?.data?.summary || {};
  const orderCounts = new Map((results.orders?.summary?.byStatus || []).map(item => [item.status, item.count]));
  const pendingOrders = orderCounts.get("PENDING") || 0;
  const awaitingReceipt = orderCounts.get("DISPATCHED") || 0;
  const declarationSummary = results.declarations?.summary;
  const declarationCounts = new Map((declarationSummary?.byStatus || []).map(item => [item.status, item.count]));
  const releaseEligible = results.batches?.summary?.releaseEligible ?? 0;

  const stats = hospital ? [
    ["Unused stock", statusCount("UNUSED_AT_HOSPITAL"), "droplet", "vials", "Available at your centre"],
    ["Mapped / used", statusCount("MAPPED_USED"), "check-circle", "vials", "Assigned to couple cases"],
    ["Couple cases", summary.couples ?? (results.couples?.data || []).length, "people", "couples", "Cases in your centre"],
    ["Requests in progress", pendingOrders + awaitingReceipt, "truck", "dispatch", "Open or awaiting receipt"]
  ] : ceo ? [
    ["Linked branches", hospitals.length, "hospital", "hospitals", "Hospital accounts connected to you"],
    ["Vials in scope", stockTotal, "droplet", "vials", "Across linked hospitals"],
    ["Open orders", pendingOrders, "truck", "dispatch", "Waiting for ART Bank"],
    ["Awaiting receipt", awaitingReceipt, "box-seam", "dispatch", "Dispatched to linked hospitals"]
  ] : [
    ["Donor registry", summary.donors ?? (results.donors?.data || []).length, "people", "donors", "Registered donor records"],
    ["Collection batches", summary.batches ?? (results.batches?.data || []).length, "collection", "batches", "Recorded collections"],
    ["Total vials", stockTotal, "droplet", "vials", "Across current inventory"],
    ["In quarantine", statusCount("QUARANTINED"), "hourglass-split", "batches", "Awaiting release eligibility"],
    ["Available at bank", statusCount("RELEASED", "AVAILABLE_AT_ART_BANK"), "check-circle", "vials", "Ready for allocation"],
    ["At hospitals", statusCount("DISPATCHED", "UNUSED_AT_HOSPITAL"), "hospital", "vials", "In hospital custody"],
    ["Mapped / used", statusCount("MAPPED_USED"), "person-check", "vials", "Linked to couple cases"],
    ["Stock requests", pendingOrders, "truck", "dispatch", "Waiting for bank review"]
  ];

  const pending = bank ? [
    ["Quarantine release reviews", releaseEligible, "batches", "hourglass-split"],
    ["Hospital stock requests", pendingOrders, "dispatch", "truck"],
    ["Unsigned drafts", declarationCounts.get("DRAFT") ?? 0, "declarations", "file-earmark-text"]
  ] : hospital ? [
    ["Dispatches awaiting receipt", awaitingReceipt, "dispatch", "box-seam"],
    ["Declarations awaiting signature", declarationSummary?.unsignedSubmitted ?? 0, "declarations", "pen"],
    ["Open stock requests", pendingOrders, "dispatch", "truck"]
  ] : [
    ["Open hospital orders", pendingOrders, "dispatch", "truck"],
    ["Orders awaiting receipt", awaitingReceipt, "dispatch", "box-seam"]
  ];

  const mix = hospital ? [
    ["Unused hospital stock", statusCount("UNUSED_AT_HOSPITAL"), "hospital"], ["Mapped / used", statusCount("MAPPED_USED"), "used"]
  ] : ceo ? [
    ["Dispatched", statusCount("DISPATCHED"), "bank"], ["Unused at hospitals", statusCount("UNUSED_AT_HOSPITAL"), "hospital"], ["Mapped / used", statusCount("MAPPED_USED"), "used"]
  ] : [
    ["At ART Bank", statusCount("RELEASED", "AVAILABLE_AT_ART_BANK"), "bank"], ["In quarantine", statusCount("QUARANTINED"), "quarantine"],
    ["At hospitals", statusCount("DISPATCHED", "UNUSED_AT_HOSPITAL"), "hospital"], ["Mapped / used", statusCount("MAPPED_USED"), "used"]
  ];
  const mixTotal = mix.reduce((sum, [, count]) => sum + count, 0);

  const hospitalName = id => hospitals.find(item => item.hospitalId === id)?.hospitalName || id || "—";
  const columns = hospital ? ["Vial", "Blood group", "Current status"] : ceo ? ["Vial", "Hospital", "Centre", "Blood group", "Current status"] : ["Vial / batch", "Donor UHID", "Blood group", "Location", "Current status", ...(superAdmin ? ["Action"] : [])];
  const hour = new Date().getHours();
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <>
      <section className="dashboard-welcome">
        <div>
          <div className="dashboard-eyebrow"><span className="live-dot" /> LIVE WORKSPACE <span className="eyebrow-divider">/</span> {user.role.replaceAll("_", " ")}</div>
          <h1>Good {hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, {user.name || user.username || "there"}</h1>
          <p>Your operational overview, updated from the current records.</p>
        </div>
        <div className="dashboard-date"><Icon name="calendar3" /><span>{today}</span></div>
      </section>
      <LoadErrors errors={data?.errors} />
      {ceo && data && !hospitals.length && (
        <div className="alert alert-info border-0 shadow-sm"><strong>No hospitals are linked to this CEO account.</strong> Ask a Super Admin to connect a hospital account.</div>
      )}
      <div className="dashboard-stats" style={{ "--stat-count": stats.length }}>
        {stats.map(([label, count, icon, target, hint], index) => (
          <Link key={label} href={`/${target}`} className={`dashboard-stat tone-${index % 4}`}>
            <span className="dashboard-stat-icon"><Icon name={icon} /></span>
            <span className="dashboard-stat-arrow"><Icon name="arrow-up-right" /></span>
            <span className="dashboard-stat-value">{count}</span>
            <span className="dashboard-stat-label">{label}</span>
            <span className="dashboard-stat-hint">{hint}</span>
          </Link>
        ))}
      </div>
      <div className="dashboard-main-grid">
        <section className="dashboard-panel activity-panel">
          <div className="dashboard-panel-head">
            <div><div className="panel-kicker">INVENTORY</div><h2>Recent stock activity</h2><p>Latest vial records in your role scope</p></div>
            <Link className="btn btn-light dashboard-view-all" href="/vials">View inventory <Icon name="arrow-right" /></Link>
          </div>
          <div className="dashboard-table-wrap">
            <DataTable headers={columns} empty={ceo ? "No vial activity is available for linked hospitals." : "No vial activity is available yet."}>
              {vials.slice(0, 8).map(vial => (
                <tr key={vial.vialId}>
                  {hospital ? (
                    <><td><VialId id={vial.vialId} /></td><td><BloodGroup value={vial.bloodGroup} /></td></>
                  ) : ceo ? (
                    <><td><VialId id={vial.vialId} /></td><td>{hospitalName(vial.hospitalId)}</td><td>{vial.centreId || "—"}</td><td><BloodGroup value={vial.bloodGroup} /></td></>
                  ) : (
                    <>
                      <td><VialId id={vial.vialId} /><span className="activity-meta">{vial.batchId || "No batch reference"}</span></td>
                      <td><span className="donor-uhid">{vial.donorUhid || vial.donorId || "—"}</span></td>
                      <td><BloodGroup value={vial.bloodGroup} /></td>
                      <td>{vial.currentLocation || "—"}</td>
                    </>
                  )}
                  <td><VialStatus status={vial.status} /></td>
                  {superAdmin && !hospital && !ceo && <td className="text-end"><RecordActions label={`vial ${vial.vialId}`} onEdit={() => records.open("editVial", vial)} onDelete={() => records.open("deleteVial", vial)} /></td>}
                </tr>
              ))}
            </DataTable>
          </div>
          <div className="activity-footer">
            <span><Icon name="shield-check" /> Showing up to 8 recent records</span>
            <Link href="/vials">Open full inventory <Icon name="arrow-right" /></Link>
          </div>
        </section>
        <aside className="dashboard-side">
          <section className="dashboard-panel next-steps-panel">
            <div className="dashboard-panel-head compact"><div><div className="panel-kicker">WORKSPACE</div><h2>Next steps</h2><p>Shortcuts for your daily workflow</p></div></div>
            <div className="dashboard-actions">
              {bank ? (
                <>
                  <Shortcut primary href="/donors" icon="person-plus" title="Register donor" text="Add a donor to the registry" />
                  <Shortcut href="/batches" icon="box-seam" title="Create collection batch" text="Record collection and generate vials" />
                  <Shortcut href="/dispatch" icon="truck" title="Review stock requests" text="Manage hospital requests" />
                </>
              ) : hospital ? (
                <>
                  <Shortcut primary href="/couples" icon="people" title="Open couple cases" text="View and manage centre cases" />
                  <Shortcut href="/dispatch" icon="truck" title="Track stock request" text="Follow delivery and receipt" />
                  <Shortcut href="/declarations" icon="file-earmark-text" title="Review declarations" text="Check documents awaiting signature" />
                </>
              ) : (
                <Shortcut primary href="/reports" icon="bar-chart-line" title="Open stock reports" text="Review available operational summaries" />
              )}
            </div>
          </section>
          <section className="dashboard-panel pending-panel">
            <div className="dashboard-panel-head compact"><div><div className="panel-kicker">ATTENTION</div><h2>Pending actions</h2></div></div>
            <div className="pending-action-list">
              {pending.map(([label, count, target, icon]) => (
                <Link key={label} href={`/${target}`} className="pending-action">
                  <span className="pending-icon"><Icon name={icon} /></span><span>{label}</span><strong>{count}</strong><Icon name="chevron-right" />
                </Link>
              ))}
            </div>
          </section>
        </aside>
      </div>
      <section className="dashboard-panel mix-panel mix-strip">
        <div className="dashboard-panel-head compact">
          <div><div className="panel-kicker">{ceo ? "LINKED HOSPITAL STOCK" : "STOCK POSITION"}</div><h2>Inventory overview</h2></div>
          <div className="d-flex align-items-center gap-3">
            <span className="mix-total">{mixTotal} <small>vials</small></span>
            <Link className="mix-footer" href="/vials">{ceo ? "Explore linked stock" : "Explore vial inventory"} <Icon name="arrow-right" /></Link>
          </div>
        </div>
        <div className="mix-strip-grid" style={{ "--mix-count": mix.length }}>
          {mix.map(([label, count, tone]) => {
            const percent = mixTotal ? Math.round(count / mixTotal * 100) : 0;
            return (
              <div className="mix-tile" key={label}>
                <div className="mix-label"><span>{label}</span><small>{percent}%</small></div>
                <strong className="mix-count">{count}</strong>
                <div className="mix-track"><span className={tone} style={{ width: `${percent}%` }} /></div>
              </div>
            );
          })}
        </div>
      </section>
      {records.element}
    </>
  );
}

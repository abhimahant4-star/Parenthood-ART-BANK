"use client";

import { useSession } from "@/components/SessionProvider";
import { PageTitle } from "@/components/ui";
import { roleLabel } from "@/lib/format";

export default function SettingsPage() {
  const { user } = useSession();
  const scope = user.role === "HOSPITAL_USER"
    ? `${user.hospitalId || "Unassigned"} / ${user.centreId || "Unassigned"}`
    : user.role === "CHAIN_CEO" ? user.chainId || "No chain scope configured" : "ART Bank operations";

  return (
    <>
      <PageTitle title="Account and portal information" subtitle="Configuration is managed through controlled deployment operations" />
      <div className="section-card">
        <div className="card-head"><strong>Current account</strong></div>
        <div className="card-body row g-3">
          <div className="col-md-6"><div className="detail-label">User</div><div className="detail-value">{user.name || user.username}</div></div>
          <div className="col-md-6"><div className="detail-label">Role</div><div className="detail-value">{roleLabel(user.role)}</div></div>
          <div className="col-md-6"><div className="detail-label">Assigned scope</div><div className="detail-value">{scope}</div></div>
          <div className="col-12"><div className="alert alert-info mb-0">This page is informational. It does not change account assignments, security settings, quarantine rules, or deployment configuration.</div></div>
        </div>
      </div>
    </>
  );
}

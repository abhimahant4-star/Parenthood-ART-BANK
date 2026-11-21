"use client";

import Link from "next/link";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, DataTable, IdTag, PageTitle, useLoader } from "@/components/ui";
import { apiRequest } from "@/lib/api";

export default function HospitalsPage() {
  const { user } = useSession();
  const { data, loading, error } = useLoader(async () => (await apiRequest("/hospitals")).data || [], []);
  const rows = (data || []).flatMap(hospital => (hospital.centres || []).map(centre => ({
    id: hospital.hospitalId, name: hospital.hospitalName || hospital.name, centreId: centre.centreId, centreName: centre.centreName || centre.name
  })));

  return (
    <>
      <PageTitle title="Hospitals and centres" subtitle="Hospital scopes are derived from active hospital user assignments" action={user.role === "SUPER_ADMIN" && <Link className="btn btn-primary" href="/users">Manage assignments</Link>} />
      <Alert message={error} />
      <div className="section-card">
        <DataTable headers={["Hospital ID", "Hospital", "Chain ID", "Centre", "Status"]} empty={loading ? "Loading hospitals…" : "No records yet"}>
          {rows.map(row => (
            <tr key={`${row.id}|${row.centreId}`}>
              <td><IdTag value={row.id} icon="hospital" /></td>
              <td className="fw-semibold">{row.name}</td>
              <td className="text-secondary">—</td>
              <td><div className="fw-semibold">{row.centreName}</div><div className="nl-mono-muted">Centre ID · {row.centreId}</div></td>
              <td><Badge status="Active" /></td>
            </tr>
          ))}
        </DataTable>
      </div>
    </>
  );
}

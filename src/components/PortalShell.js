"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "./SessionProvider";
import { Icon } from "./ui";
import { roleLabel } from "@/lib/format";

const ADMIN_NAV = [
  ["dashboard", "grid-1x2", "Dashboard"], ["donors", "people", "Donors"], ["batches", "collection", "Collections / Batches"],
  ["vials", "droplet", "Vials"], ["hospitals", "hospital", "Hospitals"], ["dispatch", "truck", "Dispatch"],
  ["declarations", "file-earmark-text", "Declarations"], ["documents", "paperclip", "Documents"], ["reports", "bar-chart", "Reports"],
  ["audit", "journal-text", "Audit Logs"], ["users", "person-gear", "Users"], ["signatures", "pen", "Signatures"]
];
const SETTINGS = ["settings", "gear", "Settings"];

export function navItems(role) {
  if (role === "HOSPITAL_USER") return [
    ["dashboard", "grid-1x2", "Dashboard"], ["vials", "droplet", "My Stock"], ["dispatch", "truck", "Stock requests"],
    ["couples", "people", "Couple Cases"], ["declarations", "file-earmark-text", "Declarations"],
    ["documents", "paperclip", "Submitted Documents"], ["reports", "bar-chart", "Reports"], SETTINGS
  ];
  if (role === "CHAIN_CEO") return [
    ["dashboard", "grid-1x2", "Dashboard"], ["hospitals", "hospital", "Hospitals"], ["vials", "droplet", "Stock"],
    ["dispatch", "truck", "Orders & dispatch"], ["reports", "bar-chart", "Stock Reports"], SETTINGS
  ];
  if (role === "SUPER_ADMIN") return [...ADMIN_NAV, SETTINGS];
  return [...ADMIN_NAV.filter(([page]) => page !== "users" && page !== "hospitals" && (role !== "ART_BANK_STAFF" || page !== "audit")), SETTINGS];
}

export function PortalShell({ children }) {
  const { user, ready, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [logoutError, setLogoutError] = useState("");
  const page = pathname.split("/")[1] || "dashboard";
  const nav = user ? navItems(user.role) : [];
  const allowed = nav.some(([item]) => item === page);

  useEffect(() => {
    if (!ready) return;
    if (!user) router.replace("/login");
    else if (!allowed) router.replace("/dashboard");
  }, [ready, user, allowed, router]);

  if (!ready || !user || !allowed) return <div className="p-5 text-center text-secondary">Loading…</div>;

  const logout = async () => {
    setLogoutError("");
    try { await signOut(); }
    catch (error) { setLogoutError(`Could not securely sign out. Please retry. ${error.message}`); }
  };

  return (
    <div className="app-shell">
      <main className="main">
        <header className="workspace-header">
          <div className="topbar">
            <Link className="brand-lockup" href="/dashboard" aria-label="Parenthood ART Bank dashboard">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/assets/images/parenthood-art-bank-logo.jpeg" alt="" />
              <span className="brand-copy"><strong>Parenthood</strong><small>ART BANK</small></span>
            </Link>
            <div className="workspace-account">
              <div className="account-copy"><strong>{user.name}</strong><span>{roleLabel(user.role)}</span></div>
              <button className="btn btn-sm btn-outline-light" type="button" onClick={logout}>
                <Icon name="box-arrow-right" className="me-sm-1" /><span className="logout-label">Logout</span>
              </button>
            </div>
          </div>
          <nav className="top-nav" aria-label="Main navigation">
            <div className="top-nav-track">
              {nav.map(([item, icon, label]) => (
                <Link key={item} href={`/${item}`} className={`top-nav-link ${page === item ? "active" : ""}`} aria-current={page === item ? "page" : undefined}>
                  <Icon name={icon} /><span>{label}</span>
                </Link>
              ))}
            </div>
          </nav>
        </header>
        <div className={`page-content ${page === "dashboard" ? "dashboard-content" : ""}`} id="content">
          {logoutError && <div className="alert alert-danger" role="alert">{logoutError}</div>}
          {children}
        </div>
      </main>
    </div>
  );
}

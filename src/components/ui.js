"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";

export function Icon({ name, className = "" }) {
  return <i className={`bi bi-${name} ${className}`.trim()} aria-hidden="true" />;
}

// Turns stored codes such as AVAILABLE_AT_ART_BANK into "Available at ART Bank".
export function statusLabel(status) {
  const text = String(status ?? "");
  if (!/[_A-Z]{3,}/.test(text) || /[a-z]/.test(text)) return text;
  return text.replaceAll("_", " ").toLowerCase().replace(/^./, letter => letter.toUpperCase()).replace(/\bart\b/g, "ART").replace(/\bceo\b/g, "CEO");
}

export function Badge({ status, label }) {
  const value = String(status || "").toUpperCase();
  let tone = "badge-gray";
  if (["RELEASED", "AVAILABLE_AT_ART_BANK", "SUBMITTED", "APPROVED", "MAPPED_USED", "ACTIVE", "RECEIVED", "DELIVERED", "COMPLETED", "NON_REACTIVE", "NORMAL"].includes(value)) tone = "badge-green";
  else if (["QUARANTINED", "PENDING", "DRAFT", "UNSUBMITTED", "UNUSED_AT_HOSPITAL", "REQUESTED", "CORRECTION_REQUESTED", "INACTIVE"].includes(value)) tone = "badge-yellow";
  else if (["BLOCKED", "RECALLED", "EXPIRED", "DISCARDED", "REJECTED", "CANCELLED", "REACTIVE", "ABNORMAL"].includes(value)) tone = "badge-red";
  else if (["DISPATCHED", "IN_TRANSIT", "CREATED"].includes(value)) tone = "badge-blue";
  return <span className={`badge-soft ${tone}`}><span className="badge-dot" aria-hidden="true" />{label ?? statusLabel(status)}</span>;
}

// Monospace ID chip in the Netlify style. Tones: indigo (primary IDs), slate (references), amber (locked/manual IDs).
export function IdTag({ value, icon, tone = "indigo", title }) {
  if (!value) return <span className="text-secondary">—</span>;
  return <span className={`nl-id nl-id-${tone}`} title={title || String(value)}>{icon && <Icon name={icon} />}{value}</span>;
}

export function BloodPill({ value }) {
  const group = String(value || "").trim().toUpperCase();
  return group ? <span className="nl-pill nl-pill-blood">{group}</span> : <span className="text-secondary">—</span>;
}

export function StockPill({ value }) {
  if (value === "KARYOTYPE_TESTED") return <span className="nl-pill nl-pill-karyotype"><span aria-hidden="true">🧬</span>Karyotype tested</span>;
  if (value === "NORMAL_STOCK") return <span className="nl-pill nl-pill-normal">Normal stock</span>;
  return <span className="text-secondary">Not specified</span>;
}

export function PageTitle({ title, subtitle, action, count }) {
  return (
    <div className="nl-page-head">
      <div className="nl-page-head-copy">
        <h1 className="page-title">{title}{count !== undefined && count !== null && <span className="nl-count">{count}</span>}</h1>
        {subtitle && <div className="nl-page-sub">{subtitle}</div>}
      </div>
      {action && <div className="nl-page-actions">{action}</div>}
    </div>
  );
}

export function Alert({ message, type = "danger", onClose }) {
  if (!message) return null;
  return (
    <div className={`alert alert-${type} ${onClose ? "alert-dismissible" : ""}`} role="alert">
      {message}
      {onClose && <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />}
    </div>
  );
}

export function LoadErrors({ errors }) {
  if (!errors?.length) return null;
  return <Alert message={`Some records could not be loaded: ${errors.map(item => item.message).join("; ")}`} type="warning" />;
}

export function DataTable({ headers, children, empty = "No records yet" }) {
  const hasRows = Array.isArray(children) ? children.flat().filter(Boolean).length > 0 : Boolean(children);
  return (
    <div className="table-responsive">
      <table className="table mb-0">
        <thead><tr>{headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead>
        <tbody>
          {hasRows ? children : <tr><td className="empty-state" colSpan={headers.length}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({ title, children, footer, onClose, className = "" }) {
  useEffect(() => {
    const onKey = event => { if (event.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
    };
  }, [onClose]);

  return (
    <>
      <div className="modal-backdrop fade show" />
      <div id="workflowModal" className={`modal fade show d-block ${className}`} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">{title}</h5>
              <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
            </div>
            <div className="modal-body">{children}</div>
            {footer && <div className="modal-footer">{footer}</div>}
          </div>
        </div>
      </div>
    </>
  );
}

// Text, date, number or select input bound to a form-state object.
export function Field({ label, name, form, setForm, type = "text", choices, col = "col-md-6", hint, onValue, ...rest }) {
  const id = `field-${name}`;
  const value = form[name] ?? "";
  const change = event => {
    const next = onValue ? onValue(event.target.value) : event.target.value;
    setForm(current => ({ ...current, [name]: next }));
  };
  return (
    <div className={col}>
      <label className="form-label" htmlFor={id}>{label}</label>
      {choices ? (
        <select className="form-select" id={id} value={value} onChange={change} {...rest}>
          {choices.map(choice => {
            const option = typeof choice === "object" ? choice : { value: choice, label: choice };
            return <option key={option.value} value={option.value}>{option.label}</option>;
          })}
        </select>
      ) : (
        <input className="form-control" id={id} type={type} value={value} onChange={change} {...rest} />
      )}
      {hint && <div className="form-text">{hint}</div>}
    </div>
  );
}

export const selectChoices = (label, values) => [{ value: "", label: `Select ${label.toLowerCase()}` }, ...values.map(value => ({ value, label: value }))];

// Runs a loader on mount and whenever its dependencies change; stale answers are ignored.
export function useLoader(loader, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: "" });
  const sequence = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableLoader = useCallback(loader, deps);

  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setState(previous => ({ ...previous, loading: true, error: "" }));
    try {
      const data = await stableLoader();
      if (current === sequence.current) setState({ data, loading: false, error: "" });
    } catch (error) {
      if (current === sequence.current) setState(previous => ({ ...previous, loading: false, error: error.message }));
    }
  }, [stableLoader]);

  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, setData: data => setState(previous => ({ ...previous, data })) };
}

// Server-paginated list with a "load next" action.
export function usePagedList(path, params = {}, extract = result => result.data || []) {
  const query = JSON.stringify(params);
  const [state, setState] = useState({ records: [], pagination: null, summary: null, loading: true, loadingMore: false, error: "" });
  const sequence = useRef(0);

  const buildPath = useCallback(skip => {
    const search = new URLSearchParams({ limit: "100", skip: String(skip) });
    Object.entries(JSON.parse(query)).forEach(([key, value]) => { if (value) search.set(key, value); });
    return `${path}?${search}`;
  }, [path, query]);

  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setState(previous => ({ ...previous, loading: true, error: "" }));
    try {
      const result = await apiRequest(buildPath(0));
      if (current !== sequence.current) return;
      setState({ records: extract(result), pagination: result.pagination || result.data?.pagination || null, summary: result.summary || null, loading: false, loadingMore: false, error: "" });
    } catch (error) {
      if (current === sequence.current) setState(previous => ({ ...previous, loading: false, error: error.message }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildPath]);

  useEffect(() => {
    const timer = setTimeout(reload, 250);
    return () => clearTimeout(timer);
  }, [reload]);

  const loadMore = useCallback(async () => {
    const page = state.pagination;
    if (!page || state.loadingMore) return;
    const current = sequence.current;
    setState(previous => ({ ...previous, loadingMore: true, error: "" }));
    try {
      const result = await apiRequest(buildPath(page.skip + page.limit));
      if (current !== sequence.current) return;
      setState(previous => ({ ...previous, records: [...previous.records, ...extract(result)], pagination: result.pagination || result.data?.pagination || null, summary: result.summary || previous.summary, loadingMore: false }));
    } catch (error) {
      setState(previous => ({ ...previous, loadingMore: false, error: error.message }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildPath, state.pagination, state.loadingMore]);

  const hasMore = Boolean(state.pagination && (state.pagination.hasMore ?? state.pagination.skip + state.records.length < state.pagination.total));
  return { ...state, hasMore, reload, loadMore };
}

export function LoadMore({ list, label = "records" }) {
  const total = list.pagination?.total ?? list.records.length;
  return (
    <div className="p-3 d-flex justify-content-between align-items-center">
      <span className="small text-secondary">{list.records.length} of {total} {label}</span>
      {list.hasMore && (
        <button className="btn btn-outline-primary" type="button" disabled={list.loadingMore} onClick={list.loadMore}>
          {list.loadingMore ? "Loading…" : `Load next ${list.pagination.limit}`}
        </button>
      )}
    </div>
  );
}

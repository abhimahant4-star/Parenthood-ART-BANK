"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, BloodPill, DataTable, Field, Icon, IdTag, LoadMore, Modal, PageTitle, StockPill, useLoader, usePagedList } from "@/components/ui";
import { apiRequest } from "@/lib/api";
import { RecordActions, useRecordModals } from "@/components/RecordActions";
import { canOperateBank, canReleaseBatch, localDate, subtractSixMonthsFromDate, todayIso } from "@/lib/format";

function nextAllowedCollection(lastCollection) {
  const next = new Date(Date.UTC(lastCollection.getUTCFullYear(), lastCollection.getUTCMonth(), lastCollection.getUTCDate()));
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 6);
  next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  return next;
}

function NewBatchModal({ onClose, onSaved }) {
  const today = todayIso();
  const [form, setForm] = useState({ batchDate: today, collectionAt: subtractSixMonthsFromDate(today), vialCount: "", stockClassification: "NORMAL_STOCK" });
  const [search, setSearch] = useState("");
  const [donor, setDonor] = useState(null);
  const [matches, setMatches] = useState(null);
  const [minimumDate, setMinimumDate] = useState("");
  const [hint, setHint] = useState("Select a donor to check their last collection date.");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const searchVersion = useRef(0);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onSearch = event => {
    const value = event.target.value;
    setSearch(value);
    setDonor(null);
    setMinimumDate("");
    setMatches(null);
    clearTimeout(timer.current);
    const version = ++searchVersion.current;
    const query = value.trim();
    setHint(query ? "Searching donors…" : "Type to search donors.");
    if (!query) return;
    timer.current = setTimeout(async () => {
      try {
        const donors = (await apiRequest(`/donors/unit-search?q=${encodeURIComponent(query)}`)).data || [];
        if (version !== searchVersion.current) return;
        setMatches(donors);
        setHint(donors.length ? "Choose a donor from the suggestions." : "Select a matching donor to see collection eligibility.");
      } catch (searchError) {
        if (version === searchVersion.current) setHint(`Could not search donors: ${searchError.message}`);
      }
    }, 250);
  };

  const selectDonor = selected => {
    setDonor(selected);
    setSearch(`${selected.manualDonorId || selected.uhid || selected.donorId} · ${selected.name}`);
    setMatches(null);
    const last = selected.lastCollectionAt ? new Date(selected.lastCollectionAt) : null;
    if (last && !Number.isNaN(last.getTime())) {
      const next = nextAllowedCollection(last);
      const minimum = next.toISOString().slice(0, 10);
      setMinimumDate(minimum);
      setHint(`Last collection: ${last.toLocaleDateString()}. Next date allowed: ${next.toLocaleDateString()}.`);
      setForm(current => (current.collectionAt && current.collectionAt < minimum ? { ...current, collectionAt: minimum } : current));
    } else {
      setMinimumDate("");
      setHint("No earlier collection found. Six-month quarantine starts on the selected collection date.");
    }
  };

  const onBatchDate = value => {
    const collection = subtractSixMonthsFromDate(value);
    setForm(current => ({ ...current, collectionAt: collection && minimumDate && collection < minimumDate ? minimumDate : collection }));
    return value;
  };

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    const { batchDate, collectionAt } = form;
    const count = Number(form.vialCount);
    const now = todayIso();
    if (!donor) return setError("Search and select a donor before creating the batch.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(collectionAt) || collectionAt > now) return setError("Enter a valid collection date that is today or earlier.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(batchDate) || batchDate > now) return setError("Enter a valid batch date that is today or earlier.");
    if (collectionAt > batchDate) return setError("Collection date cannot be later than the batch date.");
    if (!Number.isInteger(count) || count < 1 || count > 5) return setError("Vial count must be from 1 to 5.");
    if (minimumDate && collectionAt < minimumDate) return setError(`This donor's next collection date is ${minimumDate} or later.`);
    setSaving(true);
    try {
      await apiRequest("/batches", { method: "POST", body: { donorId: donor.donorId, batchDate: `${batchDate}T00:00:00.000Z`, collectionAt, vialCount: count, stockClassification: form.stockClassification } });
      onSaved();
    } catch (saveError) {
      setError(saveError.message);
      setSaving(false);
    }
  };

  const fieldProps = { form, setForm };
  return (
    <Modal title="Create collection batch" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="newBatchForm" disabled={saving}>{saving ? "Saving…" : "Create batch and generate vials"}</button>
    </>}>
      <Alert message={error} />
      <div className="alert alert-info py-2 small">Search by donor number, UHID, name, or legacy Unit Number. The donor blood group fills automatically. The collection date is filled as six months before the batch date and can be edited.</div>
      <form id="newBatchForm" className="row g-3" onSubmit={submit}>
        <div className="col-md-6">
          <label className="form-label" htmlFor="batchDonorSearch">Search donor</label>
          <div className="batch-donor-search">
            <input className="form-control" id="batchDonorSearch" type="search" autoComplete="off" placeholder="Start typing a donor ID, UHID, name, or Unit Number" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={Boolean(matches)} aria-controls="batchDonorResults" required value={search} onChange={onSearch} onKeyDown={event => { if (event.key === "Escape") setMatches(null); }} />
            <div id="batchDonorResults" className="batch-donor-search-results" role="listbox" aria-label="Donor matches" aria-live="polite">
              {matches && !matches.length && <div className="batch-donor-empty" role="status">No active donor found.</div>}
              {matches?.map(item => (
                <button key={item.donorId} className="batch-donor-option" type="button" role="option" aria-selected="false" onClick={() => selectDonor(item)}>
                  <span className="batch-donor-option-main"><strong>{item.manualDonorId || item.uhid || item.donorId}</strong><small>{item.name}</small></span>
                  <span className="batch-donor-option-blood">{item.bloodGroup || "No blood group"}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <Field {...fieldProps} label="Batch Date (Today / Selected)" name="batchDate" type="date" required max={today} onValue={onBatchDate} />
        <Field {...fieldProps} label="Collection Date (6 Mo. Prior)" name="collectionAt" type="date" required max={today} min={minimumDate || undefined} />
        <Field {...fieldProps} label="Vial count (1–5)" name="vialCount" type="number" required min={1} max={5} step={1} />
        <div className="col-md-6"><label className="form-label" htmlFor="batchBlood">Donor blood group</label><input className="form-control" id="batchBlood" readOnly required placeholder="Select a donor first" value={donor?.bloodGroup || ""} /></div>
        <Field {...fieldProps} label="Karyotype / stock classification" name="stockClassification" required choices={[{ value: "NORMAL_STOCK", label: "Normal stock" }, { value: "KARYOTYPE_TESTED", label: "Karyotype tested" }]} />
        <div className="col-12">
          <div className="form-text" aria-live="polite">{hint}</div>
          <div className="form-text">Collection date defaults to six months before the batch date. It must be today or earlier and meet the donor&apos;s collection interval.</div>
        </div>
      </form>
    </Modal>
  );
}

function BatchId({ id }) {
  const [visible, setVisible] = useState(false);
  const text = String(id || "");
  const label = visible ? "Hide full batch ID" : "Show full batch ID";
  return (
    <div className={`batch-id-cell ${visible ? "is-visible" : ""}`}>
      <span className="batch-id-preview" title={text}>{text.length > 22 ? `${text.slice(0, 18)}…` : text}</span>
      <button className="batch-id-toggle" type="button" aria-label={label} aria-expanded={visible} title={label} onClick={() => setVisible(current => !current)}><Icon name={visible ? "eye-slash" : "eye"} /></button>
      <span className="batch-id-full" aria-live="polite">{text}</span>
    </div>
  );
}

export default function BatchesPage() {
  const { user } = useSession();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState(null);
  const list = usePagedList("/batches", { q: q.trim(), status });
  const donors = useLoader(async () => (await apiRequest("/donors?limit=500")).data || [], []);
  const donorFor = id => (donors.data || []).find(donor => donor.donorId === id);
  const superAdmin = user.role === "SUPER_ADMIN";
  const records = useRecordModals(() => { list.reload(); donors.reload(); });

  const release = async batch => {
    setMessage(null);
    const end = batch.quarantineEnd ? new Date(batch.quarantineEnd) : null;
    if (!end || Number.isNaN(end.getTime())) return setMessage({ type: "danger", text: "This batch has no valid quarantine end date. It cannot be released until its record is corrected." });
    if (end > new Date()) return setMessage({ type: "warning", text: `This batch is still quarantined. It can be released after ${end.toLocaleString()}.` });
    try {
      await apiRequest(`/batches/${encodeURIComponent(batch.batchId)}/release`, { method: "POST", body: {} });
      list.reload();
    } catch (error) { setMessage({ type: "danger", text: error.message }); }
  };

  return (
    <>
      <PageTitle title="Collections / Batches" count={list.summary?.total !== undefined ? `${list.summary.total} batches` : undefined} subtitle="Collection batches, Karyotype tested vs normal stock, and the six-month quarantine" action={canOperateBank(user) && <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}><Icon name="plus-lg" className="me-1" />Create batch</button>} />
      <Alert message={message?.text} type={message?.type} onClose={() => setMessage(null)} />
      <Alert message={list.error} />
      <div className="section-card">
        <div className="card-head">
          <div className="toolbar w-100">
            <input className="form-control" style={{ maxWidth: 340 }} placeholder="Search batch ID, donor ID or Unit Number" value={q} onChange={event => setQ(event.target.value)} />
            <select className="form-select" style={{ maxWidth: 220 }} aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value)}>
              <option value="">All statuses</option><option value="QUARANTINED">Quarantined</option><option value="RELEASED">Released</option>
            </select>
            <button className="btn btn-outline-secondary" type="button" onClick={() => { setQ(""); setStatus(""); }}>Clear filters</button>
          </div>
        </div>
        <DataTable headers={["Batch ID", "Donor", "Blood group", "Stock type", "Collection date", "Vials", "Quarantine ends", "Status", "Action"]} empty={list.loading ? "Loading batches…" : "No records yet"}>
          {list.records.map(batch => {
            const donorId = batch.donor?.donorId;
            const donor = donorFor(donorId);
            const released = ["RELEASED", "AVAILABLE_AT_ART_BANK"].includes(batch.releaseStatus);
            const eligible = Boolean(batch.quarantineEnd) && new Date(batch.quarantineEnd) <= new Date();
            const daysLeft = batch.quarantineEnd ? Math.ceil((new Date(batch.quarantineEnd) - Date.now()) / 86400000) : null;
            return (
              <tr key={batch.batchId}>
                <td>{String(batch.batchId).length > 22 ? <BatchId id={batch.batchId} /> : <IdTag value={batch.batchId} icon="layers" />}</td>
                <td>
                  <div className="d-flex align-items-center gap-2 flex-wrap"><IdTag value={donor?.uhid || donorId} icon="fingerprint" tone="slate" />{donor?.manualDonorId && <span className="nl-donor-id"><Icon name="lock-fill" />{donor.manualDonorId}</span>}</div>
                  <div className="nl-mono-muted mt-1">{donor?.name || ""}</div>
                </td>
                <td><BloodPill value={batch.bloodGroup || donor?.bloodGroup} /></td>
                <td><StockPill value={batch.stockClassification} /></td>
                <td>{localDate(batch.collectionAt)}</td>
                <td><span className="nl-mono">{batch.vialCount}</span></td>
                <td>{localDate(batch.quarantineEnd)}{!released && daysLeft !== null && <div className="nl-mono-muted">{daysLeft > 0 ? `${daysLeft} days left` : "Ready to release"}</div>}</td>
                <td><Badge status={batch.releaseStatus} /></td>
                <td>
                  <div className="d-flex align-items-center gap-2">
                    {canReleaseBatch(user) && !released && <button className={`btn btn-sm ${eligible ? "btn-primary" : "btn-outline-primary"}`} type="button" title={eligible ? "Release batch" : "Click to see why release is unavailable"} onClick={() => release(batch)}>Release</button>}
                    {superAdmin && <RecordActions label={`batch ${batch.batchId}`} onEdit={() => records.open("editBatch", batch)} onDelete={() => records.open("deleteBatch", batch)} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </DataTable>
        <LoadMore list={list} label="batches" />
      </div>
      {records.element}
      {creating && <NewBatchModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); list.reload(); donors.reload(); }} />}
    </>
  );
}

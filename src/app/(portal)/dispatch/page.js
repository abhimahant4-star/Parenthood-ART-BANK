"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { Alert, Badge, DataTable, Field, Icon, LoadMore, Modal, PageTitle, selectChoices, useLoader, usePagedList } from "@/components/ui";
import { apiRequest } from "@/lib/api";
import { BLOOD_GROUPS, canOperateBank, localDate, normalizeBloodGroup } from "@/lib/format";

const compactDispatchId = value => {
  const id = String(value || "");
  return id.length > 30 ? `${id.slice(0, 13)}…${id.slice(-6)}` : id;
};
const courierReference = order => (typeof order.courierDetails === "string" ? order.courierDetails : order.courierDetails?.reference || order.courierDetails?.trackingNumber || order.courierDetails?.courier || "");

function OrderId({ id }) {
  const [visible, setVisible] = useState(false);
  const text = String(id || "");
  const label = `${visible ? "Hide" : "Show"} full order ID`;
  return (
    <div className={`compact-id-cell dispatch-order-id ${visible ? "is-visible" : ""}`}>
      <span className="compact-id-preview" title={text}>{text.length > 25 ? `${text.slice(0, 16)}...${text.slice(-6)}` : text}</span>
      <button className="compact-id-toggle" type="button" aria-label={label} aria-expanded={visible} title={label} onClick={() => setVisible(current => !current)}><Icon name={visible ? "eye-slash" : "eye"} /></button>
      <span className="compact-id-full" aria-live="polite">{text}</span>
    </div>
  );
}

function RequestStockModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState({ bloodGroup: "", quantity: "", purpose: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await apiRequest("/orders", { method: "POST", body: { hospitalId: user.hospitalId, centreId: user.centreId, items: [{ bloodGroup: normalizeBloodGroup(form.bloodGroup), quantity: Number(form.quantity) }], purpose: form.purpose } });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };
  return (
    <Modal title="Request stock" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="orderForm" disabled={saving}>{saving ? "Saving…" : "Submit request"}</button>
    </>}>
      <Alert message={error} />
      <form id="orderForm" className="row g-3" onSubmit={submit}>
        <Field form={form} setForm={setForm} label="Blood group" name="bloodGroup" required choices={selectChoices("blood group", BLOOD_GROUPS)} />
        <Field form={form} setForm={setForm} label="Quantity" name="quantity" type="number" required min={1} />
        <Field form={form} setForm={setForm} label="Purpose / notes" name="purpose" />
      </form>
    </Modal>
  );
}

function BankDispatchModal({ scopes, donors, onClose, onCreated }) {
  const [scope, setScope] = useState(scopes[0] ? `${scopes[0].hospitalId}|${scopes[0].centreId}` : "");
  const [search, setSearch] = useState("");
  const [donorId, setDonorId] = useState("");
  const [bloodGroup, setBloodGroup] = useState("");
  const [quantity, setQuantity] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const query = search.trim().toLowerCase();
  const matching = donors.filter(donor => `${donor.donorId} ${donor.uhid || ""} ${donor.manualDonorId || ""} ${donor.name || ""}`.toLowerCase().includes(query) || donor.donorId === donorId);
  const donor = donors.find(item => item.donorId === donorId);
  const group = donor?.bloodGroups?.find(item => normalizeBloodGroup(item.bloodGroup) === bloodGroup);

  const chooseDonor = id => {
    setDonorId(id);
    const selected = donors.find(item => item.donorId === id);
    setBloodGroup(selected?.bloodGroups?.length ? normalizeBloodGroup(selected.bloodGroups[0].bloodGroup) : "");
    setQuantity(selected?.bloodGroups?.length ? "1" : "");
  };
  const chooseGroup = value => {
    setBloodGroup(value);
    const selected = donor?.bloodGroups?.find(item => normalizeBloodGroup(item.bloodGroup) === value);
    setQuantity(selected ? String(Math.min(Number(quantity) || 1, selected.count)) : "");
  };

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (!donorId) return setError("Select an available donor.");
    setSaving(true);
    try {
      const [hospitalId, centreId] = scope.split("|");
      const result = await apiRequest("/orders", { method: "POST", body: { hospitalId, centreId, donorId, items: [{ bloodGroup: normalizeBloodGroup(bloodGroup), quantity: Number(quantity) }], purpose: purpose.trim() } });
      onCreated(result.data);
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  return (
    <Modal title="Send stock to hospital" onClose={onClose} className="bank-dispatch-modal" footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="bankDispatchForm" disabled={saving}>
        {saving ? <><span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />Creating dispatch…</> : <><Icon name="arrow-right-circle" className="me-2" />Continue to vial selection</>}
      </button>
    </>}>
      <Alert message={error} />
      <div className="bank-dispatch-intro">
        <span className="bank-dispatch-intro-icon"><Icon name="truck" /></span>
        <div><strong>Prepare a hospital shipment</strong><p>Select an available donor and quantity. Only released, quarantine-cleared vials will be selectable; stock is not dispatched until you confirm.</p></div>
      </div>
      <form id="bankDispatchForm" className="row g-3 bank-dispatch-form" onSubmit={submit}>
        <div className="col-12">
          <label className="form-label" htmlFor="bankScope"><Icon name="hospital" />Hospital / centre</label>
          <select id="bankScope" className="form-select" required value={scope} onChange={event => setScope(event.target.value)}>
            {scopes.map(item => <option key={`${item.hospitalId}|${item.centreId}`} value={`${item.hospitalId}|${item.centreId}`}>{item.hospitalName} — {item.centreName} ({item.centreId})</option>)}
          </select>
        </div>
        <div className="col-12">
          <label className="form-label" htmlFor="bankDonorSearch">Search available donors</label>
          <input id="bankDonorSearch" className="form-control" type="search" placeholder="Search donor number, UHID or name" value={search} onChange={event => setSearch(event.target.value)} />
          <select className="form-select mt-2" aria-label="Available donor" required value={donorId} onChange={event => chooseDonor(event.target.value)}>
            <option value="">Select a donor</option>
            {matching.map(item => <option key={item.donorId} value={item.donorId}>{item.manualDonorId || item.uhid || item.donorId} · {item.name} · {item.availableVialCount} available</option>)}
          </select>
          <div className="small text-secondary mt-2">
            {donor ? `${donor.name} · Donor No. ${donor.manualDonorId || donor.uhid || donor.donorId} · ${donor.height || "Height not recorded"} · ${donor.complexion || "Complexion not recorded"} · ${donor.eyeColour || "Eye colour not recorded"} · ${donor.hairColour || "Hair colour not recorded"} · ${donor.build || "Build not recorded"}` : "Select a donor to load available blood group and donor details."}
          </div>
        </div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="bankBlood"><Icon name="droplet-half" />Blood group</label>
          <select id="bankBlood" className="form-select" required disabled={!donor?.bloodGroups?.length} value={bloodGroup} onChange={event => chooseGroup(event.target.value)}>
            {donor?.bloodGroups?.length ? donor.bloodGroups.map(item => <option key={item.bloodGroup} value={normalizeBloodGroup(item.bloodGroup)}>{normalizeBloodGroup(item.bloodGroup)} · {item.count} available</option>) : <option value="">Select a donor first</option>}
          </select>
        </div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="bankQuantity"><Icon name="box-seam" />Quantity</label>
          <input id="bankQuantity" className="form-control" type="number" min={1} max={group?.count || 1} step={1} placeholder="Select a donor first" required disabled={!donor?.bloodGroups?.length} value={quantity} onChange={event => setQuantity(event.target.value)} />
        </div>
        <div className="col-12">
          <label className="form-label" htmlFor="bankPurpose"><Icon name="card-text" />Purpose / notes <span className="text-secondary fw-normal">(optional)</span></label>
          <textarea id="bankPurpose" className="form-control" rows={2} maxLength={500} placeholder="Add a reference or delivery note" value={purpose} onChange={event => setPurpose(event.target.value)} />
        </div>
      </form>
    </Modal>
  );
}

function CandidateGroup({ group, donorId, selected, onToggle, onCandidates }) {
  const [state, setState] = useState({ vials: [], skip: 0, hasMore: true, loading: true, error: "" });

  const load = useCallback(async skip => {
    setState(current => ({ ...current, loading: true, error: "" }));
    try {
      const params = new URLSearchParams({ status: "AVAILABLE_AT_ART_BANK", bloodGroup: group.bloodGroup, limit: "100", skip: String(skip) });
      if (donorId) params.set("donorId", donorId);
      const result = await apiRequest(`/vials?${params}`);
      const page = result.data || [];
      const eligible = page.filter(vial => vial.status === "AVAILABLE_AT_ART_BANK" && vial.quarantineEnd && new Date(vial.quarantineEnd) <= new Date());
      onCandidates(eligible);
      setState(current => ({
        vials: [...current.vials, ...eligible],
        skip: result.pagination ? result.pagination.skip + page.length : skip + page.length,
        hasMore: Boolean(result.pagination?.hasMore), loading: false, error: ""
      }));
    } catch {
      setState(current => ({ ...current, loading: false, error: "Could not load eligible vials. Retry to continue." }));
    }
  }, [group.bloodGroup, donorId, onCandidates]);

  useEffect(() => { load(0); }, [load]);

  const count = state.vials.filter(vial => selected.has(vial.vialId)).length;
  const headingId = `dispatchGroup-${group.bloodGroup}`;
  return (
    <section className="dispatch-group" aria-labelledby={headingId}>
      <div className="dispatch-group-header">
        <div className="dispatch-group-heading">
          <span className="dispatch-blood-badge">{group.bloodGroup}</span>
          <div><strong id={headingId}>{group.bloodGroup} blood group</strong><span>Choose exactly {group.quantity} vial{group.quantity === 1 ? "" : "s"}</span></div>
        </div>
        <span className={`dispatch-selection-count ${count === group.quantity ? "is-complete" : ""}`} aria-live="polite">{count} / {group.quantity} selected</span>
      </div>
      <div className="dispatch-progress" role="progressbar" aria-label={`${group.bloodGroup} vial selection progress`} aria-valuemin={0} aria-valuemax={group.quantity} aria-valuenow={count}>
        <span style={{ width: `${Math.min(100, count / group.quantity * 100)}%` }} />
      </div>
      <div className="dispatch-options-heading"><strong>Released stock</strong><span>{state.loading && !state.vials.length ? "Loading eligible options…" : `${state.vials.length} eligible option${state.vials.length === 1 ? "" : "s"} shown`}</span></div>
      <div className="dispatch-vial-list">
        {state.vials.map(vial => {
          const checked = selected.has(vial.vialId);
          const number = String(vial.vialId).match(/-(\d+)$/)?.[1] || String(vial.vialId).match(/V(\d+)$/)?.[1];
          return (
            <label className={`dispatch-vial-option ${checked ? "is-selected" : ""}`} key={vial.vialId}>
              <input className="form-check-input dispatch-vial" type="checkbox" aria-label={`Select ${vial.vialId}`} checked={checked} disabled={!checked && count >= group.quantity} onChange={() => onToggle(vial.vialId)} />
              <span className="dispatch-vial-details">
                <span className="dispatch-vial-topline"><strong>{number ? `Vial ${number}` : "Vial"}</strong><code title={vial.vialId}>{compactDispatchId(vial.vialId)}</code></span>
                <span className="dispatch-vial-meta">
                  <span><Icon name="person-badge" /><b>Donor UHID</b> {vial.donorUhid || vial.donorId || "—"}</span>
                  <span><Icon name="collection" /><b>Batch</b> <code title={vial.batchId || ""}>{compactDispatchId(vial.batchId) || "—"}</code></span>
                </span>
              </span>
              <span className="dispatch-vial-check" aria-hidden="true"><Icon name="check2" /></span>
            </label>
          );
        })}
        {state.loading && !state.vials.length && <div className="dispatch-loading"><span className="spinner-border spinner-border-sm" aria-hidden="true" />Loading eligible vials…</div>}
        {!state.loading && state.error && !state.vials.length && <div className="dispatch-empty dispatch-empty-error"><Icon name="exclamation-circle" /><span>{state.error}</span></div>}
        {!state.loading && !state.error && !state.vials.length && <div className="dispatch-empty"><Icon name="info-circle" /><span>{state.hasMore ? "No eligible vials on this page. Load more to check the remaining stock." : "No released, quarantine-cleared vials are available for this blood group."}</span></div>}
      </div>
      {(state.hasMore || state.error) && !(state.loading && !state.vials.length) && (
        <button type="button" className="btn btn-sm btn-outline-primary dispatch-load-more" disabled={state.loading} onClick={() => load(state.skip)}>
          {state.loading ? "Loading…" : state.error ? "Retry loading vials" : "Load more matching vials"}
        </button>
      )}
    </section>
  );
}

function PrepareDispatchModal({ order, onClose, onSaved }) {
  const groups = useMemo(() => {
    const requested = new Map();
    for (const item of order.items || []) {
      const group = normalizeBloodGroup(item.bloodGroup);
      requested.set(group, (requested.get(group) || 0) + Number(item.quantity));
    }
    return [...requested].map(([bloodGroup, quantity]) => ({ bloodGroup, quantity }));
  }, [order]);
  const [selected, setSelected] = useState(() => new Set());
  const [candidates, setCandidates] = useState(() => new Map());
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addCandidates = useCallback(vials => {
    setCandidates(current => {
      const next = new Map(current);
      vials.forEach(vial => next.set(vial.vialId, vial));
      return next;
    });
  }, []);
  const toggle = id => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const required = groups.reduce((sum, group) => sum + group.quantity, 0);
  const counts = new Map();
  for (const id of selected) {
    const vial = candidates.get(id);
    if (vial) { const group = normalizeBloodGroup(vial.bloodGroup); counts.set(group, (counts.get(group) || 0) + 1); }
  }
  const complete = groups.every(group => counts.get(group.bloodGroup) === group.quantity) && selected.size === required;
  const remaining = required - selected.size;

  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (!complete) return setError("Select exactly the requested number of vials for every blood group.");
    setSaving(true);
    try {
      await apiRequest(`/orders/${encodeURIComponent(order.orderId)}/dispatch`, { method: "POST", body: { vialIds: [...selected], courierDetails: reference } });
      onSaved();
    } catch (saveError) { setError(saveError.message); setSaving(false); }
  };

  return (
    <Modal title="Prepare dispatch" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="dispatchForm" disabled={!complete || saving}>{saving ? "Saving…" : complete ? `Dispatch ${required} selected vial${required === 1 ? "" : "s"}` : "Choose required vials"}</button>
    </>}>
      <Alert message={error} />
      <div className="dispatch-guide">
        <span className="dispatch-guide-icon"><Icon name="box-seam" /></span>
        <div><strong>Choose the exact vials for this order</strong><p>Only released, quarantine-cleared vials matching the requested blood group are listed. Select the required quantity in each group.</p></div>
      </div>
      <div className="dispatch-overall-status" role="status" aria-live="polite">
        {complete ? `All ${required} required vials selected. Ready to dispatch.` : `Selected ${selected.size} of ${required}. Select ${remaining} more vial${remaining === 1 ? "" : "s"} to continue.`}
      </div>
      <form id="dispatchForm" onSubmit={submit}>
        {groups.map(group => <CandidateGroup key={group.bloodGroup} group={group} donorId={order.donorId || ""} selected={selected} onToggle={toggle} onCandidates={addCandidates} />)}
        <div className="dispatch-courier-field">
          <label className="form-label" htmlFor="dispatchRef">Courier / tracking reference <span className="text-secondary fw-normal">(optional)</span></label>
          <input className="form-control" id="dispatchRef" placeholder="Add tracking number when available" value={reference} onChange={event => setReference(event.target.value)} />
          <div className="form-text">Add a tracking number or courier reference if available.</div>
        </div>
      </form>
    </Modal>
  );
}

export default function DispatchPage() {
  const { user } = useSession();
  const hospital = user.role === "HOSPITAL_USER", ceo = user.role === "CHAIN_CEO", bank = canOperateBank(user);
  const list = usePagedList("/orders");
  const hospitalsLoader = useLoader(async () => (bank || ceo ? (await apiRequest("/hospitals")).data || [] : []), [bank, ceo]);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(null);

  const hospitals = hospitalsLoader.data || [];
  const hospitalName = id => hospitals.find(item => item.hospitalId === id)?.hospitalName || id || "—";
  const scopes = hospitals.flatMap(item => (item.centres || []).map(centre => ({ hospitalId: item.hospitalId, hospitalName: item.hospitalName || item.name, centreId: centre.centreId, centreName: centre.centreName || centre.name })));
  const columns = ceo ? ["Order ID", "Hospital", "Centre", "Requested", "Vials", "Status / dispatch"] : ["Order ID", "Hospital", "Centre", "Requested", "Vials", "Status / reference", hospital ? "Requested by" : "Prepared by", "Action"];

  const startBankDispatch = async () => {
    setMessage(null);
    if (!scopes.length) return setMessage({ type: "warning", text: "No active hospital and centre accounts are available for stock dispatch." });
    try {
      const donors = (await apiRequest("/donors/available-stock")).data || [];
      if (!donors.length) return setMessage({ type: "warning", text: "No donors have released, quarantine-cleared stock available for dispatch." });
      setModal({ type: "bank", donors });
    } catch (error) { setMessage({ type: "danger", text: error.message }); }
  };
  const receive = async order => {
    setMessage(null);
    try {
      await apiRequest(`/orders/${encodeURIComponent(order.orderId)}/receive`, { method: "POST", body: { vialIds: order.vialIds } });
      list.reload();
    } catch (error) { setMessage({ type: "danger", text: error.message }); }
  };
  const finish = () => { setModal(null); list.reload(); };

  const action = hospital
    ? <button className="btn btn-primary" type="button" onClick={() => setModal({ type: "request" })}><Icon name="plus-lg" className="me-1" />Request stock</button>
    : bank ? <button className="btn btn-primary" type="button" onClick={startBankDispatch}><Icon name="truck" className="me-1" />Send stock to hospital</button> : null;

  return (
    <>
      <PageTitle title={hospital ? "Stock requests" : ceo ? "Hospital orders and dispatches" : "Dispatch"} subtitle={hospital ? "Request stock and confirm delivered vials" : ceo ? "Read-only operations for your linked hospitals" : "Review requests, select eligible vials, and track receipt"} action={action} />
      <Alert message={message?.text} type={message?.type} onClose={() => setMessage(null)} />
      <Alert message={list.error} />
      <div className="section-card dispatch-list-card">
        <DataTable headers={columns} empty={list.loading ? "Loading orders…" : "No orders or dispatches found for linked hospitals."}>
          {list.records.map(order => {
            const reference = courierReference(order);
            return (
              <tr key={order.orderId}>
                <td><OrderId id={order.orderId} />{order.dispatchedAt && <div className="dispatch-order-meta">Dispatched {localDate(order.dispatchedAt)}{order.receivedAt ? ` · Received ${localDate(order.receivedAt)}` : ""}</div>}</td>
                <td>{hospitalName(order.hospitalId)}</td>
                <td>{order.centreId}</td>
                <td>{(order.items || []).map(item => `${item.bloodGroup} × ${item.quantity}`).join(", ")}</td>
                <td>{order.vialCount ?? order.vialIds?.length ?? 0}</td>
                <td><div><Badge status={order.status} /></div>{reference && <div className="small text-secondary text-break mt-1"><span className="text-muted">Reference:</span> {reference}</div>}</td>
                {!ceo && <td>{hospital ? order.requestedBy || "" : order.dispatchedBy || ""}</td>}
                {!ceo && (
                  <td>
                    {bank && order.status === "PENDING" && <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setModal({ type: "prepare", order })}>Select vials</button>}
                    {hospital && order.status === "DISPATCHED" && <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => receive(order)}>Confirm receipt</button>}
                  </td>
                )}
              </tr>
            );
          })}
        </DataTable>
        <LoadMore list={list} label="requests" />
      </div>
      {modal?.type === "request" && <RequestStockModal user={user} onClose={() => setModal(null)} onSaved={finish} />}
      {modal?.type === "bank" && <BankDispatchModal scopes={scopes} donors={modal.donors} onClose={() => setModal(null)} onCreated={order => { list.reload(); setModal({ type: "prepare", order }); }} />}
      {modal?.type === "prepare" && <PrepareDispatchModal order={modal.order} onClose={finish} onSaved={finish} />}
    </>
  );
}

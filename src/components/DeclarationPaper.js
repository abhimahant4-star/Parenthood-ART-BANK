"use client";

import { Barcode } from "./Barcode";
import { Modal } from "./ui";

export const DEFAULT_BANK_NAME = process.env.NEXT_PUBLIC_ART_BANK_NAME || "PARENTHOOD ART BANK";
export const DEFAULT_BANK_REGD_NO = process.env.NEXT_PUBLIC_ART_BANK_REGD_NO || "";

// "Nov 14, 2026, 12:38 p.m." from a yyyy-mm-dd date and an optional hh:mm time.
const dateTimeLabel = (day, time) => {
  const parts = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : new Date(day);
  if (!day || Number.isNaN(date.getTime())) return "Not recorded";
  const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const clock = String(time || "").match(/^(\d{2}):(\d{2})$/);
  if (!clock) return label;
  const hours = Number(clock[1]);
  return `${label}, ${hours % 12 || 12}:${clock[2]} ${hours < 12 ? "a.m." : "p.m."}`;
};

// O+ -> O+VE, AB- -> AB-VE
const bloodLabel = value => {
  const group = String(value || "").trim().toUpperCase();
  return /^(A|B|AB|O)[+-]$/.test(group) ? `${group}VE` : group || "—";
};

// Donor Aadhaar as first two digits, XXX, last two digits (e.g. 82XXX11).
const donorAadhaar = masked => {
  const digits = String(masked || "").replace(/[^\d]/g, "");
  const raw = String(masked || "");
  return raw.length >= 4 && digits.length >= 4 ? `${raw.slice(0, 2)}XXX${raw.slice(-2)}` : "—";
};

// Couple Aadhaar is stored masked; show it in groups of four with X for hidden digits.
const coupleAadhaar = person => {
  if (!person?.idNumber) return "—";
  const value = String(person.idNumber).replace(/[•*]/g, "X").replace(/\s+/g, "");
  return person.idType && person.idType !== "Aadhaar" ? `${person.idType}: ${value}` : value.replace(/(.{4})(?=.)/g, "$1 ");
};

const ageOn = (dob, day) => {
  const birth = dob ? new Date(dob) : null;
  const at = day ? new Date(day) : new Date();
  if (!birth || Number.isNaN(birth.getTime()) || Number.isNaN(at.getTime())) return "";
  let age = at.getFullYear() - birth.getFullYear();
  if (at.getMonth() < birth.getMonth() || (at.getMonth() === birth.getMonth() && at.getDate() < birth.getDate())) age -= 1;
  return age >= 0 ? age : "";
};

const upper = value => String(value || "").trim().toUpperCase();

export function DeclarationPaper({ declaration, couple, donor, signer, hospitalName, centreName }) {
  const data = declaration.declarationData || {};
  const vials = declaration.vialIds || data.vials || [];
  const donorNumber = data.donorNumber || donor?.manualDonorId || donor?.uhid || donor?.donorId || data.donor || "—";
  const trait = key => upper(data[key] || donor?.[key]) || "—";
  const descriptor = ["height", "complexion", "eyeColour", "hairColour", "build"].map(key => data[key] || donor?.[key]).filter(Boolean).map(upper).join(", ");
  const age = data.donorAge ?? ageOn(donor?.dob, data.sampleDate);
  const bankName = upper(data.bankName || DEFAULT_BANK_NAME);
  const regdNo = data.bankRegistrationNumber || DEFAULT_BANK_REGD_NO || "—";
  const sampleId = data.sampleId || (declaration.declarationId !== "PREVIEW" ? declaration.declarationId : "") || vials[0] || "";
  const hospital = data.hospitalName || hospitalName || declaration.hospitalId || "—";
  const centre = data.centreName || centreName || "";
  const wife = couple?.wife?.name || data.patientName || "—";

  return (
    <article className="declaration-paper declaration-report">
      <header className="declaration-report-header">
        <div className="declaration-report-header-left">
          <p>Patient Name : <strong>MR. {donorNumber}{descriptor ? ` ( ${descriptor} )` : ""}</strong></p>
          <p>Referral : {bankName} ({regdNo})</p>
          <p>Sample Date : {dateTimeLabel(data.sampleDate, data.sampleTime)}</p>
        </div>
        <div className="declaration-report-header-right">
          <p>Age : {age !== "" ? `${age} Year(s)` : "—"} (Male)</p>
          <p>Reg. ID : I - {data.registrationId || donorNumber}</p>
          <p>Report Date : {dateTimeLabel(data.date, data.reportTime)}</p>
          <div className="declaration-report-sample-id"><span>Sample ID :</span><Barcode value={sampleId} /></div>
        </div>
      </header>
      <h4 className="declaration-report-title">{bankName}: ART BANK REGD NO: {regdNo}</h4>
      <div className="declaration-report-recipient">
        <p>To, The Doctor</p>
        <p>{hospital}{centre && centre !== hospital ? `, ${centre}` : ""} (INDIA)</p>
        <p>Dear Sir/Madam</p>
      </div>
      <p className="declaration-intro"><strong>As per your requirement we are providing the following prepared&nbsp; High DNA integrity Frozen Donor Semen Samples</strong></p>
      <div className="table-responsive declaration-report-table-wrap">
        <table className="table table-bordered declaration-sample-table declaration-report-table">
          <colgroup>{[6, 13, 10, 9, 8, 13, 10, 9, 11, 11].map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup>
          <thead>
            <tr>
              <th>S.NO.</th><th>SAMPLE<br />USED FOR<br />PATIENT</th><th>DONOR NO.</th><th>BLOOD GP.</th><th>HEIGHT</th><th>COMPLEXION</th><th>EYE COLOR</th><th>HAIR<br />COLOR</th><th>BUILD</th><th>AADHAR</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>1</td>
              <td className="declaration-report-patient">
                {wife}<br />W/O<br />{couple?.husband?.name || "—"}
                <span className="declaration-report-id-proof">ADHAAR<br />WIFE:<br />{coupleAadhaar(couple?.wife)}</span>
                <span className="declaration-report-id-proof">ADHAAR<br />HUSBAND:<br />{coupleAadhaar(couple?.husband)}</span>
              </td>
              <td>{donorNumber}<br />{vials.length} VIAL{vials.length === 1 ? "" : "S"}</td>
              <td>{bloodLabel(data.bloodGroup || donor?.bloodGroup)}</td><td>{trait("height")}</td><td>{trait("complexion")}</td><td>{trait("eyeColour")}</td><td>{trait("hairColour")}</td><td>{trait("build")}</td><td>{donorAadhaar(data.aadhaarMasked || donor?.aadhaarMasked)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="declaration-report-notes">
        <p>● All the Donor samples are morphologically analyzed (Kruger&apos;s criteria), DNA Fragmentation Tested,</p>
        <p>processed with IVF grade Density Gradient with minimum 30 million sperm concentration/ml AND</p>
        <p>75% Post Thaw motility in each vial and quarantined for 6 months.</p>
        <p>● All Donor&apos;s are re-tested at 6 months interval for viral markers (HIV, HBsAg, HCV), VDRL.</p>
        <p>● Screened for Thalassemia, Sickle cell anemia.</p>
        <p>● Other tests done: CBC, Random Blood Sugar, Liver &amp; Renal function tests, Semen Culture.</p>
      </div>
      <div className="row declaration-signatures declaration-report-signatures">
        <div className="col-6">________________________<br />ART Bank Authorised Officer</div>
        <div className="col-6 text-end"><div className="declaration-report-signature-space" />{signer?.name || ""}<br />{signer?.designation || ""}</div>
      </div>
    </article>
  );
}

export function DeclarationPreviewModal({ onClose, ...paper }) {
  return (
    <Modal title="Declaration preview" onClose={onClose} footer={<>
      <button className="btn btn-light" type="button" onClick={onClose}>Close</button>
      <button className="btn btn-outline-primary" type="button" onClick={() => window.print()}>Print</button>
    </>}>
      <DeclarationPaper {...paper} />
      <p className="declaration-preview-note">Preview only. Confirm the patient, donor, vial and registration details before issuing.</p>
    </Modal>
  );
}

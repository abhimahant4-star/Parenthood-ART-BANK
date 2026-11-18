"use client";

import { Modal } from "./ui";

const dateLabel = value => {
  if (!value) return "Not recorded";
  const parts = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
};

const maskedIdentity = person => {
  if (!person?.idType) return "Not provided";
  return person.idType === "Aadhaar" ? "XXXX XXXX XXXX" : `${person.idType}: XXXX`;
};

export function DeclarationPaper({ declaration, couple, donor, signer }) {
  const data = declaration.declarationData || {};
  const vials = declaration.vialIds || data.vials || [];
  const donorNumber = data.donorNumber || donor?.manualDonorId || donor?.uhid || donor?.donorId || data.donor || "—";
  const sampleId = data.sampleId || declaration.declarationId || "—";
  const patientName = data.patientName || couple?.wife?.name || "—";
  const hasAge = data.patientAge !== undefined && data.patientAge !== null && data.patientAge !== "";
  const ageSex = hasAge ? `${data.patientAge} Year(s)${data.patientSex ? ` (${data.patientSex})` : ""}` : "Not provided";
  const trait = key => data[key] || donor?.[key] || "—";

  return (
    <article className="declaration-paper declaration-report">
      <header className="declaration-report-header">
        <div className="declaration-report-header-left">
          <p>Patient Name : <strong>{patientName}</strong></p>
          <p>Referral : {data.referral || "—"}</p>
          <p>Sample Date : {dateLabel(data.sampleDate)}</p>
        </div>
        <div className="declaration-report-header-right">
          <p>Age : {ageSex}</p>
          <p>Reg. ID : I - {data.registrationId || declaration.coupleId || "—"}</p>
          <p>Report Date : {dateLabel(data.date)}</p>
          <div className="declaration-report-sample-id">
            <span>Sample ID :</span>
            <span className="declaration-barcode" aria-label={`Sample ID ${sampleId}`}>
              <span className="declaration-barcode-bars" aria-hidden="true" />
              <span>{sampleId}</span>
            </span>
          </div>
        </div>
      </header>
      <h4 className="declaration-report-title">{data.bankName || "PARENTHOOD ART BANK"}: ART BANK REGD NO: {data.bankRegistrationNumber || "—"}</h4>
      <div className="declaration-report-recipient">
        <p>To, The Doctor</p>
        <p>{declaration.hospitalId || "—"}{declaration.centreId ? `, ${declaration.centreId}` : ""} (INDIA)</p>
        <p>Dear Sir/Madam</p>
      </div>
      <p className="declaration-intro">As per your requirement we are providing the following prepared&nbsp; High DNA integrity Frozen Donor Semen Samples</p>
      <div className="table-responsive declaration-report-table-wrap">
        <table className="table table-bordered declaration-sample-table declaration-report-table">
          <colgroup>{[7, 14, 11, 11, 9, 11, 10, 10, 10, 7].map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup>
          <thead>
            <tr>
              <th>S.NO.</th><th>SAMPLE<br />USED FOR<br />PATIENT</th><th>DONOR NO.</th><th>BLOOD GP.</th><th>HEIGHT</th><th>COMPLEXION</th><th>EYE COLOR</th><th>HAIR<br />COLOR</th><th>BUILD</th><th>AADHAR</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>1</td>
              <td className="declaration-report-patient">
                {couple?.wife?.name || patientName}<br />W/O<br />{couple?.husband?.name || "—"}
                <span className="declaration-report-id-proof">ID PROOF<br />WIFE:<br />{maskedIdentity(couple?.wife)}</span>
                <span className="declaration-report-id-proof">ID PROOF<br />HUSBAND:<br />{maskedIdentity(couple?.husband)}</span>
              </td>
              <td>{donorNumber}<br />{vials.length} VIAL{vials.length === 1 ? "" : "S"}</td>
              <td>{trait("bloodGroup")}</td><td>{trait("height")}</td><td>{trait("complexion")}</td><td>{trait("eyeColour")}</td><td>{trait("hairColour")}</td><td>{trait("build")}</td><td>{trait("aadhaarMasked")}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="declaration-report-vials"><strong>Mapped vial ID(s):</strong> {vials.join(", ") || "—"}</p>
      <p className="declaration-statement">{data.statement || "I confirm that the patient, donor and mapped vial details above are correct."}</p>
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
      <p className="declaration-preview-note">Preview only. Confirm report values, clinical statements, and registration details before issuing.</p>
    </Modal>
  );
}

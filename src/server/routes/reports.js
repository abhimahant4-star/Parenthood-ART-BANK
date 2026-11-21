const router = require("../http/router").Router();
const { requireAuth, allowRoles } = require("../middleware/auth");

const Donor = require("../models/Donor");
const Batch = require("../models/Batch");
const Vial = require("../models/Vial");
const Order = require("../models/Order");
const Patient = require("../models/Patient");
const Couple = require("../models/Couple");
const Declaration = require("../models/Declaration");
const Signature = require("../models/Signature");
const AuditLog = require("../models/AuditLog");
const { publicErrorMessage } = require("../services/errorResponseService");
const { stockCsvStream } = require("../services/stockCsvService");
const { couplePatientCsvStream } = require("../services/couplePatientCsvService");
const { orderCsvStream } = require("../services/orderCsvService");
const { getLinkedHospitalScopes, withLinkedHospitalScope } = require("../services/linkedHospitalScopeService");
const { csvFromRecords } = require("../services/csvService");
const { withTraceSummary, donorListFilter, BLOOD_GROUPS } = require("../services/donorTraceService");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PDFDocument = require("pdfkit");

function parseReportDate(value, endOfDay = false) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function reportDateRange(from, to) {
  const fromDate = from === undefined ? null : parseReportDate(from);
  const toDate = to === undefined ? null : parseReportDate(to, true);
  const toStart = to === undefined ? null : parseReportDate(to);
  if ((from !== undefined && !fromDate) || (to !== undefined && !toDate) || (fromDate && toStart && fromDate > toStart)) {
    const error = new Error("Report dates must be valid YYYY-MM-DD values with from on or before to");
    error.status = 400;
    error.errorCode = "INVALID_REPORT_DATE";
    throw error;
  }
  return { fromDate, toDate };
}

async function recordExport(req, format, entity) {
  await AuditLog.create({
    userId: req.user.id,
    role: req.user.role,
    action: "REPORT_EXPORT",
    entity,
    summary: `${format} report export`,
    ip: req.ip,
    newValues: { format }
  });
}


// ======================================================
// Helper: Build scoped order query
// ======================================================

function buildOrderQuery(req) {
  const {
    hospitalId,
    centreId,
    status,
    from,
    to
  } = req.query;

  const { fromDate, toDate } = reportDateRange(from, to);

  // Branch-to-chain membership is not represented in the current data model.
  // Fail closed until that relationship exists; otherwise CEO exports would be global.
  if (req.user.role === "CHAIN_CEO") {
    return { query: { _id: { $exists: false } }, scopedHospitalId: null, scopedCentreId: null };
  }

  if (req.user.role === "HOSPITAL_USER" && (!req.user.hospitalId || !req.user.centreId)) {
    const error = new Error("Hospital account has no assigned hospital/centre");
    error.status = 403;
    throw error;
  }

  let scopedHospitalId = hospitalId || null;
  let scopedCentreId = centreId || null;

  // Hospital users can ONLY access their own hospital/centre.
  if (req.user.role === "HOSPITAL_USER") {
    scopedHospitalId = req.user.hospitalId;
    scopedCentreId = req.user.centreId;
  }

  const query = {};

  if (scopedHospitalId) {
    query.hospitalId = scopedHospitalId;
  }

  if (scopedCentreId) {
    query.centreId = scopedCentreId;
  }

  if (status) {
    query.status = status;
  }

  if (fromDate || toDate) {
    query.createdAt = {};
    if (fromDate) query.createdAt.$gte = fromDate;
    if (toDate) query.createdAt.$lte = toDate;
  }

  return {
    query,
    scopedHospitalId,
    scopedCentreId
  };
}

async function streamOrderExport(req, res, { bom = false, errorCode, errorMessage }) {
  let orderCursor;
  try {
    const { query } = buildOrderQuery(req);
    orderCursor = Order.find(query).sort({ createdAt: -1, _id: -1 }).lean().cursor({ batchSize: 100 });
    await recordExport(req, "CSV", "ORDERS_REPORT");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="art-bank-orders-report.csv"');
    await pipeline(Readable.from(orderCsvStream(orderCursor, { bom })), res);
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy(error);
      return;
    }
    res.status(error.status || 500).json({
      success: false,
      message: error.status === 400 ? error.message : publicErrorMessage(error, errorMessage),
      errorCode: error.errorCode || errorCode
    });
  } finally {
    if (orderCursor) await orderCursor.close().catch(() => {});
  }
}


// ======================================================
// GET /api/reports
// Report summary
// ======================================================

router.get(
  "/",
  requireAuth,
  allowRoles(
    "SUPER_ADMIN",
    "ART_BANK_ADMIN",
    "ART_BANK_STAFF",
    "HOSPITAL_USER",
    "CHAIN_CEO"
  ),
  async (req, res) => {
    try {
      if (req.user.role === "CHAIN_CEO") {
        const scopes = await getLinkedHospitalScopes(req.user.id);
        if (!scopes.length) {
          return res.json({ success: true, data: { available: false, summary: { branches: null, donors: null, batches: null, vials: null, orders: null, couples: null, declarations: null, signatures: null } }, message: "No hospital accounts are linked to this CEO" });
        }
        const { hospitalId, centreId, status, from, to } = req.query;
        const fromDate = from === undefined ? null : parseReportDate(from);
        const toDate = to === undefined ? null : parseReportDate(to, true);
        if ((from !== undefined && !fromDate) || (to !== undefined && !toDate) || (fromDate && toDate && fromDate > new Date(`${String(to)}T00:00:00.000Z`))) {
          return res.status(400).json({ success: false, message: "Report dates must be valid YYYY-MM-DD values with from on or before to", errorCode: "INVALID_REPORT_DATE" });
        }
        const dateFilter = {};
        if (fromDate) dateFilter.$gte = fromDate;
        if (toDate) dateFilter.$lte = toDate;
        const orderFilter = {};
        if (hospitalId) orderFilter.hospitalId = hospitalId;
        if (centreId) orderFilter.centreId = centreId;
        if (status) orderFilter.status = status;
        if (Object.keys(dateFilter).length) orderFilter.createdAt = dateFilter;
        const vialFilter = {
          ...(hospitalId ? { hospitalId } : {}),
          ...(centreId ? { centreId } : {}),
          ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {})
        };
        const [vialCount, orderCount] = await Promise.all([
          Vial.countDocuments(withLinkedHospitalScope(vialFilter, scopes)),
          Order.countDocuments(withLinkedHospitalScope(orderFilter, scopes))
        ]);
        return res.json({
          success: true,
          data: {
            available: true,
            filters: { hospitalId: hospitalId || null, centreId: centreId || null, status: status || null, from: from || null, to: to || null },
            summary: { branches: scopes.length, donors: null, batches: null, vials: vialCount, orders: orderCount, couples: null, declarations: null, signatures: null }
          },
          message: "Linked hospital operational report generated successfully"
        });
      }
      const {
        hospitalId,
        centreId,
        status,
        from,
        to
      } = req.query;

      const fromDate = from === undefined ? null : parseReportDate(from);
      const toDate = to === undefined ? null : parseReportDate(to, true);
      if ((from !== undefined && !fromDate) || (to !== undefined && !toDate) || (fromDate && toDate && fromDate > new Date(`${String(to)}T00:00:00.000Z`))) {
        return res.status(400).json({ success: false, message: "Report dates must be valid YYYY-MM-DD values with from on or before to", errorCode: "INVALID_REPORT_DATE" });
      }

      const dateFilter = {};

      if (fromDate) dateFilter.$gte = fromDate;
      if (toDate) dateFilter.$lte = toDate;

      let scopedHospitalId = hospitalId || null;
      let scopedCentreId = centreId || null;

      if (req.user.role === "HOSPITAL_USER") {
        if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
        scopedHospitalId = req.user.hospitalId;
        scopedCentreId = req.user.centreId;
      }


      // ==================================================
      // COUPLES
      // ==================================================

      const coupleQuery = {};

      if (scopedHospitalId) {
        coupleQuery.hospitalId = scopedHospitalId;
      }

      if (scopedCentreId) {
        coupleQuery.centreId = scopedCentreId;
      }

      if (status) {
        coupleQuery.status = status;
      }

      if (Object.keys(dateFilter).length) {
        coupleQuery.createdAt = dateFilter;
      }

      const coupleCount =
        await Couple.countDocuments(coupleQuery);


      // ==================================================
      // DECLARATIONS
      // ==================================================

      const declarationQuery = {};

      if (scopedHospitalId) {
        declarationQuery.hospitalId = scopedHospitalId;
      }

      if (scopedCentreId) {
        declarationQuery.centreId = scopedCentreId;
      }

      if (status) {
        declarationQuery.status = status;
      }

      if (req.user.role === "HOSPITAL_USER") {
        declarationQuery.status = { $in: ["SUBMITTED", "APPROVED"] };
      }

      if (Object.keys(dateFilter).length) {
        declarationQuery.createdAt = dateFilter;
      }

      const declarationCount =
        await Declaration.countDocuments(declarationQuery);


      // ==================================================
      // SIGNATURES
      // ==================================================

      const signatureQuery = {};

      if (scopedHospitalId) {
        signatureQuery.hospitalId = scopedHospitalId;
      }

      if (scopedCentreId) {
        signatureQuery.centreId = scopedCentreId;
      }

      if (Object.keys(dateFilter).length) {
        signatureQuery.createdAt = dateFilter;
      }

      const signatureCount =
        await Signature.countDocuments(signatureQuery);


      // ==================================================
      // ORDERS
      // ==================================================

      const orderQuery = {};

      if (scopedHospitalId) {
        orderQuery.hospitalId = scopedHospitalId;
      }

      if (scopedCentreId) {
        orderQuery.centreId = scopedCentreId;
      }

      if (status) {
        orderQuery.status = status;
      }

      if (Object.keys(dateFilter).length) {
        orderQuery.createdAt = dateFilter;
      }

      const orderCount =
        await Order.countDocuments(orderQuery);


      // ==================================================
      // ART BANK INVENTORY
      // ==================================================

      let donorCount = null;
      let batchCount = null;
      let vialCount = null;

      if (
        req.user.role === "SUPER_ADMIN" ||
        req.user.role === "ART_BANK_ADMIN" ||
        req.user.role === "ART_BANK_STAFF"
      ) {
        const inventoryDateQuery =
          Object.keys(dateFilter).length
            ? { createdAt: dateFilter }
            : {};

        donorCount =
          await Donor.countDocuments(inventoryDateQuery);

        batchCount =
          await Batch.countDocuments(inventoryDateQuery);

        vialCount =
          await Vial.countDocuments(inventoryDateQuery);
      } else if (req.user.role === "HOSPITAL_USER") {
        const hospitalInventoryQuery = { hospitalId: req.user.hospitalId, centreId: req.user.centreId, status: "UNUSED_AT_HOSPITAL" };
        if (Object.keys(dateFilter).length) hospitalInventoryQuery.createdAt = dateFilter;
        vialCount = await Vial.countDocuments(hospitalInventoryQuery);
      }


      return res.json({
        success: true,

        data: {
          filters: {
            hospitalId: scopedHospitalId,
            centreId: scopedCentreId,
            status: status || null,
            from: from || null,
            to: to || null
          },

          summary: {
            donors: donorCount,
            batches: batchCount,
            vials: vialCount,
            orders: orderCount,
            couples: coupleCount,
            declarations: declarationCount,
            signatures: signatureCount
          }
        },

        message: "Report generated successfully"
      });

    } catch (e) {
      console.error(e);

      return res.status(500).json({
        success: false,
        message: publicErrorMessage(e, "Failed to fetch report"),
        errorCode: "REPORT_GENERATION_ERROR"
      });
    }
  }
);


// ======================================================
router.get("/stock.csv", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER"), async (req, res) => {
  try {
    const filter = {};
    if (req.user.role === "HOSPITAL_USER") {
      if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      filter.hospitalId = req.user.hospitalId;
      filter.centreId = req.user.centreId;
    }
    const vials = Vial.find(filter).sort({ createdAt: -1, _id: -1 }).lean().cursor();
    const hospitalUser = req.user.role === "HOSPITAL_USER";
    await recordExport(req, "CSV", "VIAL_STOCK_REPORT");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="art-bank-stock.csv"');
    try {
      await pipeline(Readable.from(stockCsvStream(vials, hospitalUser)), res);
    } finally {
      await vials.close().catch(() => {});
    }
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy(error);
      return;
    }
    res.status(error.status || 500).json({ success: false, message: publicErrorMessage(error, "Failed to export stock"), errorCode: "STOCK_EXPORT_ERROR" });
  }
});

// GET /api/reports/export/csv
// CSV export
// ======================================================

router.get(
  "/export/csv",
  requireAuth,
  allowRoles(
    "SUPER_ADMIN",
    "ART_BANK_ADMIN",
    "ART_BANK_STAFF",
    "HOSPITAL_USER"
  ),
  (req, res) => streamOrderExport(req, res, {
    errorCode: "CSV_EXPORT_ERROR",
    errorMessage: "Failed to export orders CSV"
  })
);


// ======================================================
// Legacy GET /api/reports/export/excel path; serves safe CSV instead of XLSX.
// ======================================================

router.get(
  "/export/excel",
  requireAuth,
  allowRoles(
    "SUPER_ADMIN",
    "ART_BANK_ADMIN",
    "ART_BANK_STAFF",
    "HOSPITAL_USER"
  ),
  (req, res) => streamOrderExport(req, res, {
    bom: true,
    errorCode: "EXCEL_EXPORT_ERROR",
    errorMessage: "Failed to export orders spreadsheet"
  })
);


// ======================================================
// GET /api/reports/export/pdf
// PDF export
// ======================================================

router.get(
  "/export/pdf",
  requireAuth,
  allowRoles(
    "SUPER_ADMIN",
    "ART_BANK_ADMIN",
    "ART_BANK_STAFF",
    "HOSPITAL_USER"
  ),
  async (req, res) => {
    let orderCursor;
    try {

      const {
        query,
        scopedHospitalId,
        scopedCentreId
      } = buildOrderQuery(req);


      const orderCount = await Order.countDocuments(query);
      orderCursor = Order.find(query).sort({ createdAt: -1, _id: -1 }).lean().cursor({ batchSize: 100 });
      await recordExport(req, "PDF", "ORDERS_REPORT");


      const doc =
        new PDFDocument({
          margin: 40,
          size: "A4"
        });


      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="art-bank-orders-report.pdf"'
      );


      doc.pipe(res);


      // ==================================================
      // PDF TITLE
      // ==================================================

      doc
        .fontSize(18)
        .text(
          "Parenthood ART Bank",
          {
            align: "center"
          }
        );

      doc
        .moveDown(0.3)
        .fontSize(14)
        .text(
          "Orders Report",
          {
            align: "center"
          }
        );

      doc.moveDown();


      // ==================================================
      // FILTER INFORMATION
      // ==================================================

      doc
        .fontSize(9)
        .text(
          `Hospital: ${
            scopedHospitalId || "All"
          }`
        );

      doc.text(
        `Centre: ${
          scopedCentreId || "All"
        }`
      );

      doc.text(
        `Status: ${
          req.query.status || "All"
        }`
      );

      doc.text(
        `From: ${
          req.query.from || "All"
        }`
      );

      doc.text(
        `To: ${
          req.query.to || "All"
        }`
      );

      doc.moveDown();


      // ==================================================
      // SUMMARY
      // ==================================================

      doc
        .fontSize(11)
        .text(
          `Total Orders: ${orderCount}`
        );

      doc.moveDown();


      // ==================================================
      // ORDER DATA
      // ==================================================

      if (orderCount === 0) {

        doc
          .fontSize(10)
          .text(
            "No orders found for the selected filters."
          );

      } else {

        let index = 0;
        for await (const order of orderCursor) {

          const vialIds =
            Array.isArray(order.vialIds)
              ? order.vialIds.join(", ")
              : "N/A";


          doc
            .fontSize(11)
            .text(
              `${index + 1}. Order ID: ${
                order.orderId || "N/A"
              }`
            );

          doc
            .fontSize(9)
            .text(
              `Hospital: ${
                order.hospitalId || "N/A"
              }`
            );

          doc.text(
            `Centre: ${
              order.centreId || "N/A"
            }`
          );

          doc.text(
            `Requested By: ${
              order.requestedBy || "N/A"
            }`
          );

          doc.text(
            `Purpose: ${
              order.purpose || "N/A"
            }`
          );

          doc.text(
            `Status: ${
              order.status || "N/A"
            }`
          );

          doc.text(
            `Vial IDs: ${vialIds}`
          );

          doc.text(
            `Dispatched By: ${
              order.dispatchedBy || "N/A"
            }`
          );

          doc.text(
            `Received By: ${
              order.receivedBy || "N/A"
            }`
          );

          doc.text(
            `Created At: ${
              order.createdAt
                ? new Date(
                    order.createdAt
                  ).toISOString()
                : "N/A"
            }`
          );

          doc.moveDown();


          // Prevent content from running off page
          if (
            doc.y > 720 &&
            index < orderCount - 1
          ) {
            doc.addPage();
          }

          index++;
        }
      }


      // ==================================================
      // FOOTER
      // ==================================================

      doc
        .fontSize(8)
        .text(
          "Generated by Parenthood ART Bank",
          40,
          760,
          {
            align: "center",
            width: 515
          }
        );


      doc.end();

    } catch (e) {

      console.error(e);

      if (res.headersSent || res.destroyed) {
        if (!res.destroyed) res.destroy(e);
        return;
      } else {

        return res.status(e.status || 500).json({
          success: false,
          message: e.status === 400 ? e.message : publicErrorMessage(e, "Failed to export orders PDF"),
          errorCode: e.errorCode || "PDF_EXPORT_ERROR"
        });

      }
    } finally {
      if (orderCursor) await orderCursor.close().catch(() => {});
    }
  }
);

// ======================================================
// GET /api/reports/export/couples
// Detailed Couple + Patient Export
// Super Admin only
// ======================================================

router.get(
  "/export/couples",
  requireAuth,
  allowRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const {
        hospitalId,
        centreId,
        status,
        from,
        to
      } = req.query;

      const coupleQuery = {};

      if (hospitalId) {
        coupleQuery.hospitalId = hospitalId;
      }

      if (centreId) {
        coupleQuery.centreId = centreId;
      }

      if (status) {
        coupleQuery.status = status;
      }

      const { fromDate, toDate } = reportDateRange(from, to);
      if (fromDate || toDate) {
        coupleQuery.createdAt = {};
        if (fromDate) coupleQuery.createdAt.$gte = fromDate;
        if (toDate) coupleQuery.createdAt.$lte = toDate;
      }

      await recordExport(req, "CSV", "COUPLES_PATIENTS_REPORT");
      const couples = Couple.aggregate([
        { $match: coupleQuery },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $lookup: {
            from: Patient.collection.name,
            let: { selectedCoupleId: "$coupleId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$coupleId", "$$selectedCoupleId"] } } },
              { $sort: { createdAt: -1, _id: -1 } },
              { $project: { patientId: 1, name: 1, gender: 1, dateOfBirth: 1, status: 1 } }
            ],
            as: "patient"
          }
        },
        { $unwind: { path: "$patient", preserveNullAndEmptyArrays: true } }
      ]).cursor({ batchSize: 100 });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="couples-patients.csv"');
      try {
        await pipeline(Readable.from(couplePatientCsvStream(couples)), res);
      } finally {
        await couples.close().catch(() => {});
      }

    } catch (e) {
      if (res.headersSent || res.destroyed) {
        if (!res.destroyed) res.destroy(e);
        return;
      }
      res.status(e.status || 500).json({
        success: false,
        message: e.status === 400 ? e.message : publicErrorMessage(e, "Failed to export couple and patient report"),
        errorCode: e.errorCode || "COUPLE_PATIENT_EXPORT_ERROR"
      });
    }
  }
);

// ======================================================
// ART Bank register exports: donor registry, quarantine ledger and utilization.
// ======================================================

const BANK_ROLES = ["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"];
const EXPORT_ROW_LIMIT = 20000;
const dateOnly = value => (value ? new Date(value).toISOString().slice(0, 10) : "");
const stockLabel = value => (value === "KARYOTYPE_TESTED" ? "Karyotype tested" : value === "NORMAL_STOCK" ? "Normal stock" : "");
const resultLabel = value => (value ? value.replaceAll("_", " ").toLowerCase().replace(/^./, letter => letter.toUpperCase()) : "Not recorded");
const bloodGroupFilter = query => (BLOOD_GROUPS.includes(query.bloodGroup) ? { bloodGroup: query.bloodGroup } : {});

function sendCsv(res, filename, rows, headers) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(csvFromRecords(rows, headers));
}

async function donorLookup(donorIds) {
  const donors = await Donor.find({ donorId: { $in: [...new Set(donorIds.filter(Boolean))] } }).select("donorId uhid manualDonorId").lean();
  return new Map(donors.map(donor => [donor.donorId, donor]));
}

function registerExport(path, entity, errorCode, build) {
  router.get(path, requireAuth, allowRoles(...BANK_ROLES), async (req, res) => {
    try {
      const { filename, rows, headers } = await build(req);
      await recordExport(req, "CSV", entity);
      return sendCsv(res, filename, rows, headers);
    } catch (error) {
      console.error(error);
      return res.status(error.status || 500).json({ success: false, message: publicErrorMessage(error, "Failed to export report"), errorCode });
    }
  });
}

registerExport("/donors.csv", "DONOR_REGISTRY_REPORT", "DONOR_EXPORT_ERROR", async req => {
  const donors = await Donor.find(donorListFilter(req.query)).select("-aadhaarHash").sort({ createdAt: -1 }).limit(EXPORT_ROW_LIMIT).lean();
  const today = new Date();
  const rows = (await withTraceSummary(donors)).map(donor => {
    const dob = donor.dob ? new Date(donor.dob) : null;
    let age = "";
    if (dob) {
      age = today.getUTCFullYear() - dob.getUTCFullYear();
      if (today.getUTCMonth() < dob.getUTCMonth() || (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate())) age -= 1;
    }
    const screening = donor.screening || {};
    return {
      "UHID": donor.uhid || donor.donorId, "Manual donor ID": donor.manualDonorId, "Legal name": donor.name,
      "Date of birth": dateOnly(donor.dob), "Age": age, "Marital status": donor.maritalStatus, "Blood group": donor.bloodGroup,
      "Status": donor.status || "Active", "Aadhaar (masked)": donor.aadhaarMasked,
      "Height": donor.height, "Complexion": donor.complexion, "Eye colour": donor.eyeColour, "Hair colour": donor.hairColour, "Build": donor.build,
      "Batches": donor.trace.batchIds.join(" "), "Vials available": donor.trace.vialAvailable, "Vials total": donor.trace.vialTotal,
      "HIV 1 & 2": resultLabel(screening.hiv), "HBsAg": resultLabel(screening.hbsag), "HCV": resultLabel(screening.hcv),
      "VDRL": resultLabel(screening.vdrl), "Thalassemia": resultLabel(screening.thalassemia), "Karyotype": resultLabel(screening.karyotype),
      "Screening date": dateOnly(screening.testedOn), "Registered": dateOnly(donor.createdAt)
    };
  });
  return { filename: "donor-registry.csv", rows, headers: Object.keys(rows[0] || { "UHID": "" }) };
});

registerExport("/quarantine.csv", "QUARANTINE_LEDGER_REPORT", "QUARANTINE_EXPORT_ERROR", async req => {
  const batches = await Batch.find(bloodGroupFilter(req.query)).sort({ collectionAt: -1 }).limit(EXPORT_ROW_LIMIT).lean();
  const donors = await donorLookup(batches.map(batch => batch.donor?.donorId));
  const now = Date.now();
  const headers = ["Batch ID", "UHID", "Manual donor ID", "Blood group", "Stock type", "Vials", "Collection date", "Quarantine start", "Quarantine end", "Days remaining", "Release status", "Approved by"];
  const rows = batches.map(batch => {
    const donor = donors.get(batch.donor?.donorId) || {};
    const end = batch.quarantineEnd ? new Date(batch.quarantineEnd).getTime() : null;
    return {
      "Batch ID": batch.batchId, "UHID": donor.uhid || batch.donor?.donorId, "Manual donor ID": donor.manualDonorId,
      "Blood group": batch.bloodGroup, "Stock type": stockLabel(batch.stockClassification), "Vials": batch.vialCount,
      "Collection date": dateOnly(batch.collectionAt), "Quarantine start": dateOnly(batch.quarantineStart), "Quarantine end": dateOnly(batch.quarantineEnd),
      "Days remaining": end === null ? "" : Math.max(0, Math.ceil((end - now) / 86400000)), "Release status": batch.releaseStatus, "Approved by": batch.approvedBy
    };
  });
  return { filename: "quarantine-ledger.csv", rows, headers };
});

registerExport("/utilization.csv", "UTILIZATION_REPORT", "UTILIZATION_EXPORT_ERROR", async req => {
  const vials = await Vial.find({ status: "MAPPED_USED", ...bloodGroupFilter(req.query) }).sort({ updatedAt: -1 }).limit(EXPORT_ROW_LIMIT).lean();
  const donors = await donorLookup(vials.map(vial => vial.donorId));
  const headers = ["Vial ID", "UHID", "Manual donor ID", "Batch ID", "Blood group", "Stock type", "Hospital", "Centre", "Couple case", "Mapped on", "Mapped by"];
  const rows = vials.map(vial => {
    const donor = donors.get(vial.donorId) || {};
    const mapped = [...(vial.statusHistory || [])].reverse().find(entry => entry?.status === "MAPPED_USED") || {};
    return {
      "Vial ID": vial.vialId, "UHID": donor.uhid || vial.donorId, "Manual donor ID": donor.manualDonorId, "Batch ID": vial.batchId,
      "Blood group": vial.bloodGroup, "Stock type": stockLabel(vial.stockClassification), "Hospital": vial.hospitalId, "Centre": vial.centreId,
      "Couple case": mapped.coupleId, "Mapped on": dateOnly(mapped.at), "Mapped by": mapped.by
    };
  });
  return { filename: "utilization-mapping.csv", rows, headers };
});

module.exports = router;

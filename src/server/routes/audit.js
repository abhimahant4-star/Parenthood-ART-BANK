const router = require("../http/router").Router();
const AuditLog = require("../models/AuditLog");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { publicErrorMessage } = require("../services/errorResponseService");
const { projectAuditLog } = require("../services/auditPrivacyService");
const { csvFromRecords } = require("../services/csvService");

const EXPORT_ROW_LIMIT = 50000;

function auditQuery({ action, role, entity, from, to }) {
  const query = {};
  if (action) query.action = action;
  if (role) query.role = role;
  if (entity) query.entity = entity;
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }
  return query;
}

router.get(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"),
  async (req, res) => {
    try {
      const { limit = 100, skip = 0 } = req.query;
      const parsedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const parsedSkip = Math.min(Math.max(Number(skip) || 0, 0), 100000);
      const query = auditQuery(req.query);

      const [logs, total] = await Promise.all([AuditLog.find(query)
        .sort({ createdAt: -1, _id: -1 }).skip(parsedSkip).limit(parsedLimit).lean(), AuditLog.countDocuments(query)]);

      res.json({
        success: true,
        data: {
          count: logs.length,
          logs: logs.map(projectAuditLog)
        },
        pagination: { skip: parsedSkip, limit: parsedLimit, total, hasMore: parsedSkip + logs.length < total }
      });
    } catch (e) {
      console.error(e);

      res.status(500).json({
        success: false,
        message: publicErrorMessage(e, "Failed to fetch audit logs"),
        errorCode: "AUDIT_LOG_ERROR"
      });
    }
  }
);

// Lists the action and entity names that exist, for the filter dropdowns.
router.get("/options", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"), async (req, res) => {
  try {
    const [actions, entities] = await Promise.all([AuditLog.distinct("action"), AuditLog.distinct("entity")]);
    const clean = (values, pattern) => values.filter(value => typeof value === "string" && pattern.test(value)).sort();
    return res.json({ success: true, data: { actions: clean(actions, /^[A-Z][A-Z0-9_]{0,99}$/), entities: clean(entities, /^[A-Za-z][A-Za-z0-9_]{0,79}$/) } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: publicErrorMessage(e, "Failed to load audit filters"), errorCode: "AUDIT_OPTIONS_ERROR" });
  }
});

// Exports the filtered, privacy-projected audit trail as CSV. The export itself is audited.
router.get("/export.csv", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"), async (req, res) => {
  try {
    const logs = await AuditLog.find(auditQuery(req.query)).sort({ createdAt: -1, _id: -1 }).limit(EXPORT_ROW_LIMIT).lean();
    await AuditLog.create({ userId: String(req.user.id), role: req.user.role, action: "REPORT_EXPORT", entity: "AUDIT_TRAIL_REPORT", summary: "CSV report export", ip: req.ip, newValues: { format: "CSV" } });
    const headers = ["Time", "Action", "User ID", "Role", "Entity", "Entity ID", "Details", "IP address"];
    const rows = logs.map(projectAuditLog).map(log => ({
      "Time": log.createdAt ? new Date(log.createdAt).toISOString() : "", "Action": log.action, "User ID": log.userId, "Role": log.role,
      "Entity": log.entity, "Entity ID": log.entityId,
      "Details": Object.entries(log.newValues || {}).map(([key, value]) => `${key}=${value}`).join("; "), "IP address": log.ip
    }));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="audit-trail.csv"');
    return res.send(csvFromRecords(rows, headers));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: publicErrorMessage(e, "Failed to export audit trail"), errorCode: "AUDIT_EXPORT_ERROR" });
  }
});

module.exports = router;

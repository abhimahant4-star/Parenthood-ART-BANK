const router = require("../http/router").Router();
const AuditLog = require("../models/AuditLog");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { publicErrorMessage } = require("../services/errorResponseService");
const { projectAuditLog } = require("../services/auditPrivacyService");

router.get(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"),
  async (req, res) => {
    try {
      const {
        action,
        role,
        entity,
        from,
        to,
        limit = 100,
        skip = 0
      } = req.query;

      const parsedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const parsedSkip = Math.min(Math.max(Number(skip) || 0, 0), 100000);

      const query = {};

      if (action) query.action = action;
      if (role) query.role = role;
      if (entity) query.entity = entity;

      if (from || to) {
        query.createdAt = {};

        if (from) {
          query.createdAt.$gte = new Date(from);
        }

        if (to) {
          const end = new Date(to);
          end.setHours(23, 59, 59, 999);
          query.createdAt.$lte = end;
        }
      }

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

module.exports = router;

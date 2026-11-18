const ROLES = new Set(["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER", "CHAIN_CEO"]);
const VALUE_TYPES = new Map([
  ["previousStatus", "status"], ["status", "status"], ["count", "number"], ["format", "format"],
  ["version", "number"], ["baseVersion", "number"], ["resultingVersion", "number"],
  ["hospitalId", "id"], ["centreId", "id"], ["batchId", "id"], ["orderId", "id"],
  ["coupleId", "id"], ["vialId", "id"], ["declarationId", "id"], ["attachmentId", "id"],
  ["requestId", "id"], ["roleChanged", "role"], ["assignedRole", "role"], ["active", "boolean"]
]);

function projectAuditValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    const type = VALUE_TYPES.get(key);
    if (!type) continue;
    if (type === "number") {
      if (Number.isSafeInteger(value) && value >= 0) result[key] = value;
      continue;
    }
    if (type === "boolean") {
      if (typeof value === "boolean") result[key] = value;
      continue;
    }
    if (typeof value !== "string" || !value || value.length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(value)) continue;
    if (type === "status" && !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) continue;
    if (type === "format" && !/^[A-Z]{2,10}$/.test(value)) continue;
    if (type === "role" && !ROLES.has(value)) continue;
    result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function projectAuditLog(record) {
  const action = typeof record?.action === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(record.action)
    ? record.action
    : "AUDIT_EVENT";
  const result = {
    _id: record?._id,
    userId: typeof record?.userId === "string" && record.userId.length <= 128 ? record.userId : "",
    role: ROLES.has(record?.role) ? record.role : "",
    action,
    entity: typeof record?.entity === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(record.entity) ? record.entity : "",
    entityId: typeof record?.entityId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(record.entityId) ? record.entityId : "",
    summary: action.replaceAll("_", " ").toLowerCase(),
    ip: typeof record?.ip === "string" && record.ip.length <= 64 ? record.ip : "",
    createdAt: record?.createdAt
  };
  const newValues = projectAuditValues(record?.newValues);
  if (newValues) result.newValues = newValues;
  return result;
}

module.exports = { projectAuditValues, projectAuditLog };

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
export const DONOR_TRAIT_OPTIONS = {
  complexion: ["Fair", "Wheatish"],
  eyeColour: ["Black", "Brown"],
  hairColour: ["Black", "Brown"],
  build: ["Slim", "Moderate"]
};
export const HEIGHT_QUICK_PICKS = ["5.6 ft", "5.7 ft", "5.8 ft", "5.9 ft", "5.10 ft", "5.11 ft", "6.0 ft"];

export const ROLE_LABELS = {
  SUPER_ADMIN: "Super Admin",
  ART_BANK_ADMIN: "ART Bank Admin",
  ART_BANK_STAFF: "ART Bank Staff",
  HOSPITAL_USER: "Hospital / Centre User",
  CHAIN_CEO: "Hospital Chain CEO / Head"
};
export const roleLabel = role => ROLE_LABELS[role] || role;

export const canOperateBank = user => ["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"].includes(user?.role);
export const canReleaseBatch = user => ["SUPER_ADMIN", "ART_BANK_ADMIN"].includes(user?.role);

export const normalizeBloodGroup = value => String(value || "").trim().toUpperCase();
export const localDate = value => (value ? new Date(value).toLocaleDateString() : "—");
export const localDateTime = value => (value ? new Date(value).toLocaleString() : "—");
export const todayIso = () => new Date().toISOString().slice(0, 10);

export function dobParts(dob) {
  if (!dob) return null;
  const text = dob instanceof Date ? dob.toISOString() : String(dob).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const check = new Date(parts[0], parts[1] - 1, parts[2]);
  if (check.getFullYear() !== parts[0] || check.getMonth() !== parts[1] - 1 || check.getDate() !== parts[2]) return null;
  return parts;
}

export function ageFromDob(dob) {
  const parts = dobParts(dob);
  if (!parts) return "";
  const [year, month, day] = parts;
  const now = new Date();
  let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)) age -= 1;
  return age >= 0 ? age : "";
}

export function displayDob(dob) {
  const parts = dobParts(dob);
  if (!parts) return "";
  const [year, month, day] = parts;
  return new Date(year, month - 1, day).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function subtractSixMonthsFromDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - 6);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

export function addMonths(value, months) {
  const date = new Date(value);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, last));
  return date;
}

export function validUploadFile(file, imagesOnly = false) {
  if (!file) return false;
  const allowed = imagesOnly ? ["image/png", "image/jpeg"] : ["application/pdf", "image/png", "image/jpeg"];
  return allowed.includes(file.type) && file.size <= 10 * 1024 * 1024;
}

export const compactId = value => {
  const text = String(value || "");
  return text.length > 24 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text || "—";
};

export const VIAL_STATUS_LABELS = {
  CREATED: "Created", QUARANTINED: "In quarantine", RELEASED: "Released", AVAILABLE_AT_ART_BANK: "Available at ART Bank",
  DISPATCHED: "Dispatched", UNUSED_AT_HOSPITAL: "Unused at hospital", RETURNED_BEFORE_MAPPING: "Returned",
  MAPPED_USED: "Mapped / used", BLOCKED: "Blocked", RECALLED: "Recalled", DISCARDED: "Discarded", EXPIRED: "Expired"
};
export const VIAL_STATUS_TONES = {
  CREATED: "gray", QUARANTINED: "yellow", RELEASED: "green", AVAILABLE_AT_ART_BANK: "green", DISPATCHED: "blue",
  UNUSED_AT_HOSPITAL: "yellow", RETURNED_BEFORE_MAPPING: "blue", MAPPED_USED: "green", BLOCKED: "red",
  RECALLED: "red", DISCARDED: "red", EXPIRED: "red"
};

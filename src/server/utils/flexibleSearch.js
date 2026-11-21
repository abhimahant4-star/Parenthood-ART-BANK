"use strict";

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches IDs while ignoring dashes, slashes and spaces, so "O4545", "o/4545" and "4545"
// all find "O/4545", and "BAT101" finds "BAT-101". Letters are optional because the
// match is a "contains" search: typing only the number still finds the ID.
function flexibleIdPattern(search, { prefix = false } = {}) {
  const characters = [...String(search || "").slice(0, 100)].filter(character => /[A-Za-z0-9]/.test(character));
  if (!characters.length) return new RegExp(escapeRegex(String(search || "").trim()), "i");
  return new RegExp(`${prefix ? "^[^A-Za-z0-9]*" : ""}${characters.map(escapeRegex).join("[^A-Za-z0-9]*")}`, "i");
}

// Plain "contains" match for free text such as names and locations.
const containsPattern = search => new RegExp(escapeRegex(String(search || "").trim().slice(0, 100)), "i");

// Strips everything except letters and digits, for comparing IDs typed in different ways.
const compactId = value => String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

module.exports = { flexibleIdPattern, containsPattern, compactId, escapeRegex };

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const User = require("../models/User");
const { scopeId, hasHospitalScopeNameCollision } = require("../utils/scopeIds");

test("scope IDs remain stable for names differing only by case, accents and whitespace", () => {
  assert.equal(scopeId("HOSP", "Café   Clinic"), scopeId("HOSP", "CAFE CLINIC"));
  assert.equal(hasHospitalScopeNameCollision([
    { hospitalId: "HOSP-CAFE-CLINIC", hospitalName: "Café Clinic", centreId: "CENTRE-NORTH", centreName: "North" }
  ], { hospitalId: "HOSP-CAFE-CLINIC", hospitalName: "CAFE CLINIC", centreId: "CENTRE-NORTH", centreName: "north" }), false);
});

test("distinct hospital or same-hospital centre names that collapse to one ID are detected", () => {
  const hospitalName = "St. Mary's Hospital";
  const otherHospitalName = "St Mary's Hospital";
  assert.equal(scopeId("HOSP", hospitalName), scopeId("HOSP", otherHospitalName));
  assert.equal(hasHospitalScopeNameCollision([
    { hospitalId: scopeId("HOSP", hospitalName), hospitalName, centreId: "CENTRE-NORTH-UNIT", centreName: "North Unit" }
  ], { hospitalId: scopeId("HOSP", otherHospitalName), hospitalName: otherHospitalName, centreId: "CENTRE-NORTH-UNIT", centreName: "North Unit" }), true);

  assert.equal(hasHospitalScopeNameCollision([
    { hospitalId: "HOSP-A", hospitalName: "Hospital A", centreId: "CENTRE-NORTH-UNIT", centreName: "North-Unit" }
  ], { hospitalId: "HOSP-A", hospitalName: "Hospital A", centreId: scopeId("CENTRE", "North Unit"), centreName: "North Unit" }), true);
});

test("same centre label in a different hospital does not collide", () => {
  assert.equal(hasHospitalScopeNameCollision([
    { hospitalId: "HOSP-A", hospitalName: "Hospital A", centreId: "CENTRE-NORTH", centreName: "North" }
  ], { hospitalId: "HOSP-B", hospitalName: "Hospital B", centreId: "CENTRE-NORTH", centreName: "North" }), false);
});

test("scope serialization counter is hidden from API projections and declares no index", () => {
  assert.equal(User.schema.path("scopeRegistryVersion").options.select, false);
  assert.equal(User.schema.indexes().some(([keys]) => Object.hasOwn(keys, "scopeRegistryVersion")), false);
});

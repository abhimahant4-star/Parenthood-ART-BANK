"use strict";

const SIGNATURE_ID_INDEX = { signatureId: 1 };
const LEGACY_DECLARATION_INDEX = { declarationId: 1 };
const VERSIONED_DECLARATION_INDEX = { declarationId: 1, declarationVersion: 1 };

function hasExactKeys(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length && expectedEntries.every(([key, value], index) =>
    actualEntries[index]?.[0] === key && actualEntries[index]?.[1] === value
  );
}

function findIndex(indexes, keys, unique) {
  return (indexes || []).find(index =>
    hasExactKeys(index.key, keys) &&
    Boolean(index.unique) === unique &&
    !index.partialFilterExpression &&
    index.sparse !== true &&
    !index.collation
  );
}

function inspectSignatureIndexes(indexes) {
  const signatureIdUnique = findIndex(indexes, SIGNATURE_ID_INDEX, true);
  const legacyDeclarationUnique = findIndex(indexes, LEGACY_DECLARATION_INDEX, true);
  const versionedDeclarationUnique = findIndex(indexes, VERSIONED_DECLARATION_INDEX, true);
  const conflictingVersionedIndex = findIndex(indexes, VERSIONED_DECLARATION_INDEX, false);
  return {
    signatureIdUnique,
    legacyDeclarationUnique,
    versionedDeclarationUnique,
    conflictingVersionedIndex,
    ready: Boolean(signatureIdUnique && versionedDeclarationUnique && !legacyDeclarationUnique && !conflictingVersionedIndex)
  };
}

module.exports = {
  SIGNATURE_ID_INDEX,
  LEGACY_DECLARATION_INDEX,
  VERSIONED_DECLARATION_INDEX,
  inspectSignatureIndexes
};

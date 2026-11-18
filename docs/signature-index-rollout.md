# Declaration Signature Index Rollout

Status: **application support prepared; operational rollout not executed**. The isolated `parenthood_phase1_test` database was inspected read-only. No production database was accessed, no signature metadata was backfilled, and no production index operation was run. Existing deployments must retain the single-field unique index until a separately approved staged maintenance operation replaces it.

## Current compatibility behavior

- `src/server/models/Signature.js` declares `signatureId` unique and the versioned compound index `{ declarationId: 1, declarationVersion: 1 }` unique. Existing databases may still have the old unique single-field index; the model does not remove it. Production startup disables Mongoose automatic index and collection creation.
- `src/server/services/declarationVersionService.js` treats a signature without `declarationVersion` as version 1. A version 1 signature is current only for declaration version 1; it is not current for version 2.
- `src/server/services/signatureVersioningService.js` enables versioned operations only when it can verify the exact required unique indexes and complete, valid version metadata. Readiness failures are fail-closed.
- `src/server/routes/declarationCorrections.js` atomically invalidates the current version's signature during approval only when that readiness check passes. Otherwise, a signed declaration remains unchanged and approval returns `SIGNATURE_VERSIONING_REQUIRED`.
- `src/server/routes/signatures.js` creates signatures bound to the current declaration version. It rejects a version greater than 1 while storage readiness is false. Current-signature reads filter by version and validity; history omits `signatureData`.
- The latest isolated preflight on `parenthood_phase1_test` found the legacy unique index still present and no malformed versions, duplicates or unresolved declaration references. That test database remains fail-closed. Production index state has not been inspected.
- Do not remove or overwrite a historical signature to work around the unique index.

## Implemented application behavior and remaining enablement gates

Version-aware application support is implemented, but production re-signing remains disabled until the staged index and metadata rollout is separately approved and completed. The application now:

1. Treat a legacy signature without `declarationVersion` as version 1 at runtime.
2. On correction approval, preserve the old signature document and bytes, set `valid: false`, and record invalidation time, reviewer and correction request ID in the same transaction as the declaration version, correction request, and audit event.
3. Create a new version-bound signature without replacing a historical signature once storage readiness passes.
4. Query current signatures by declaration and version; history responses omit `signatureData`.
5. Use conditional declaration writes and duplicate-key conflicts to prevent stale signing or double signing.

Isolated integration tests verify fail-closed behavior under the legacy index and exercise transactional invalidation with capability readiness. A separate test-only collection using the versioned Signature schema verifies coexistence of version 1 and version 2 signatures, concurrent signing, current-signature retrieval, and history privacy. This does not change the application's `signatures` collection indexes; the actual rollout remains gated.

Do not enable multiple-version signing by changing the index alone. Deploy the reviewed application code before the maintenance window, but keep writes paused throughout the staged transition.

## Target index shape

Keep the unique `signatureId` index. Replace the unique single-field `declarationId` index with a unique compound index:

```javascript
{ declarationId: 1, declarationVersion: 1 }
```

This allows at most one signature for each declaration version and supports declaration history lookups. Every legacy signature must receive `declarationVersion: 1` before this unique index can be built. Do not assign a version based on current declaration state: a legacy signature always represents the original version 1.

Before execution, confirm the exact deployed index names and key definitions using a read-only index listing. Do not assume MongoDB generated a particular name. Also check for duplicate `(declarationId, declarationVersion)` values, missing declaration references and malformed version metadata. Existing `declarationId` uniqueness prevents multiple records per declaration today, but the compound-index preflight remains mandatory.

`scripts/migrate-signature-index.js` implements the staged metadata/index rollout. It defaults to read-only inspection, does not load any `.env` file, does not print the MongoDB URI, and connects only to the explicitly supplied `MONGODB_URI`. Read-only preflight requires `--confirm-database` to match the URI database name. Each apply stage separately requires `--apply`, one `--stage` (`backfill`, `create-compound-index`, or `drop-legacy-index`), and operator acknowledgements `SIGNATURE_INDEX_CHANGE_APPROVED=YES`, `SIGNATURE_INDEX_BACKUP_VERIFIED=YES`, and `SIGNATURE_WRITES_PAUSED=YES`. Apply mode verifies a writable replica-set primary, checks the `signatureId` unique index, refuses malformed versions, duplicate version pairs, and unresolved declaration references. The backfill stage changes only missing/null `declarationVersion` to `1`; the next stage creates and verifies the compound index while retaining the old index; the final stage requires the exact old index name and drops only that index. Review and record verification output between stages. The script has not been run in apply mode; unit tests cover index classification, integrity-counter query shape, and fail-closed invocation gates.

Read-only invocation after an operator has supplied the approved URI through its protected environment:

```powershell
node scripts/migrate-signature-index.js --confirm-database <exact-database-name>
```

Apply invocation is intentionally omitted from copy/paste commands here. It requires the separate written maintenance approval, verified backup, paused signature writes, the exact database confirmation, and the exact legacy index name returned by preflight. Do not infer approval from the presence of this script.

## Staged rollout

### 0. Release gates and recovery preparation

- Obtain separate written approval for the production maintenance, metadata backfill and index removal. This document is not that approval.
- Confirm that the target MongoDB is a transaction-capable replica set and that the exact application target is known through the organization's deployment controls. Never put database credentials in commands, tickets or logs.
- Take a consistent database backup and prove restore into an isolated environment. Record the recovery owner and maintenance window.
- Review and test the application changes from the section above on the isolated `parenthood_phase1_test` replica set, including transaction rollback and concurrent signing/approval cases.
- Pause signature creation and declaration correction approval for the full index transition. Keep ordinary declaration reads available if the release process permits.

### 1. Deploy compatibility code with signing changes disabled

Deploy a release that understands legacy version 1 signatures and contains the new version-aware implementation, but still refuses new signatures for already-signed declarations and refuses signed declaration corrections. Drain every previous application instance before continuing. Do not allow mixed old and new application processes to write signatures.

The compatibility release now declares the compound versioned index and no longer requests a unique single-field `declarationId` index. Production connection options disable both automatic index and collection creation, so production startup will not perform this transition. Mongoose defaults enable those behaviors outside production; inspect any non-production database before connecting this release. Verify production connection options and every expected live index through the separately approved read-only preflight before any index transition.

### 2. Read-only production preflight

Using an approved operator session, save the output of `getIndexes()` for the signature collection and run read-only aggregation checks for:

- duplicate `(declarationId, effective declarationVersion)` pairs, interpreting missing `declarationVersion` as 1;
- invalid, null or non-integer explicit versions;
- declarations with more than one signature (if any exist despite the current unique index);
- signatures whose declarations are missing;
- signature counts and counts of records with missing `declarationVersion`.

Stop if any result is unexpected. Resolve discrepancies with a separately reviewed data-repair plan; never delete or rewrite signature content.

### 3. Backfill legacy metadata

With all signature writes paused and a verified backup available, run a separately reviewed, resumable update that sets `declarationVersion: 1` only where the field is missing or null. Do not change `signatureData`, `signedAt`, `valid`, signer fields or declaration content. Save the matched/modified counts and verify that no signature remains without a valid positive integer `declarationVersion`.

This is a data write and requires separate explicit operational authorization. It was not performed for this project work.

### 4. Build and verify the compound index

Create the unique compound index `{ declarationId: 1, declarationVersion: 1 }` under a separately approved change window. Keep the old unique `declarationId` index during index creation and verification. Confirm the compound index exists with the exact key order and unique option. Do not enable re-signing yet: the old index still blocks a second version.

### 5. Remove the old unique index

After compound-index verification, identify the old unique single-field index by the exact name and key definition recorded in step 2. In the same maintenance window, drop only that exact index. Never use `dropIndexes`, `dropIndex('*')`, collection drops or broad index synchronization. Confirm:

- the compound unique index remains present;
- `signatureId` uniqueness remains present;
- no other signature indexes changed;
- a dry-run transaction in the isolated environment demonstrates that two distinct versions can coexist and duplicate versions are rejected.

This live index removal requires separate explicit authorization and was not performed here.

### 6. Enable and monitor versioned signing

Enable the reviewed application feature only after the index checks pass. Verify a new version can be signed while the old version remains stored and invalid, and that all current-signature reads return only the signature for the declaration's current version. Monitor duplicate-key conflicts, transaction aborts and signature audit events. Keep the old signature bytes untouched.

## Mixed-version and rollback rules

- Old application instances assume one signature per declaration. They must be fully drained before index removal or versioned writes.
- Once a second signature exists, rolling back to old application code is unsafe: old readers can select the wrong signature and old writers cannot correctly reason about multiple versions. Do not roll back to a release that lacks version-aware signature queries.
- If the new application has a defect after versioned signatures are written, disable signature creation and correction approval through the reviewed operational control, keep the version-aware read release running, and repair forward. Restoring the backup is a disaster-recovery action that can lose later writes and requires incident command approval.
- Recreating the old unique index is impossible while multiple versions exist. Do not attempt it. A rollback plan must preserve the compound index and use code that remains compatible with versioned records.
- If index creation fails, leave the old index intact, keep workflows paused, and diagnose the reported duplicate or resource issue. Do not drop existing indexes to make the operation pass.

## Acceptance checklist

- [ ] Isolated integration tests pass against only `parenthood_phase1_test` on a local replica set.
- [ ] Backup restore has been proven in an isolated environment.
- [ ] Read-only production index/data preflight has been reviewed and signed off.
- [ ] Legacy signatures are backfilled to version 1 without altering signature bytes.
- [ ] Compound unique index is verified before the old index is removed.
- [ ] Only the exact old `declarationId` unique index is removed; `signatureId` uniqueness remains.
- [ ] No old application process remains before versioned writes are enabled.
- [ ] Old signatures remain preserved and invalid for newer declaration versions.
- [ ] Version-aware signing, correction approval, audit, and rollback behavior are verified.

No database or index operation is authorized by this runbook. Production execution requires a separate approval and the organization's controlled release process.

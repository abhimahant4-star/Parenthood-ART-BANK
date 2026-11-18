# Final Client Acceptance Verification - Parenthood ART Bank

> **Follow-up update (2026-11-14):** The workflow requirements below were revised after this report's 2026-11-03 browser review. Current behavior removes Unit Number from new donor registration (age 21–55), limits batches to 1–5 vials, defaults the batch date to today and the editable collection date to six months earlier, and keeps quarantine end at least six months after collection. It also adds dedicated hospital registration and donor-linked stock dispatch, hides donor/batch/history details from hospital accounts, and links declarations and optional supporting documents to the mapped-vial donor. The full isolated backend suite passed 164 tests, and the frontend startup check passed. The local Docker API and web services were rebuilt and returned HTTP 200 at `/api/health` and `/`. No authenticated browser review was repeated for these follow-up changes; the acceptance table below is historical and its earlier Unit Number, age, and vial-count expectations are superseded. The Docker build emitted an npm audit warning for one high-severity issue; it was not investigated or changed as part of this workflow task.

**Review date:** 2026-11-03  
**Scope:** Current workspace source, schemas, route rules, database-free tests, isolated Phase 1 API tests, and Phase 3 browser acceptance evidence. No production database or records were read or changed. No commit, push, deployment, or database reset was performed.

## Acceptance summary

This is a code review and partial automated verification, not a client acceptance sign-off. The isolated Phase 1 suite completed, and Phase 3 includes authenticated Playwright runs in Microsoft Edge with desktop/mobile screenshots. The vial-count native range validation was fixed and browser-verified. The client has confirmed that the two stock classifications fully satisfy the Karyotype requirement.

| # | Client requirement | Status | Evidence and limits |
|---|---|---|---|
| 1 | Overall UI/UX | **PASS (focused desktop/mobile review)** | Authenticated dashboard, donor, batch, vial, dispatch, and hospital inventory screens were rendered; 1440×1000 desktop and 390×844 mobile screenshots are in Phase 3. This was not a full accessibility/device matrix. |
| 2 | Show donor Unit Number on registration | **PASS (browser)** | Registered a synthetic donor through the UI; verified saved Unit Number and donor-list search. |
| 3 | Remove collection time, retain date | **PASS (browser/API)** | UI showed `type=date`; future date was rejected; saved date was date-only and normalized. |
| 4 | Auto-populate donor blood group in Batch Collection | **PASS (browser/database)** | Selecting the Unit Number search result populated `O+`; the saved batch and vials retained donor blood group. |
| 5 | Six-month validation in Batch Collection | **PASS (browser/API)** | One day before rejected, exact eligibility date created through UI, one day after accepted; future quarantine prevented release and eligible test batch released. |
| 6 | Vial count 3-9 and generated IDs | **PASS (browser)** | Native `#bCount` range is min 3/max 9. Browser validity rejected 2 and 10, accepted 3 and 9; UI-created batches generated 3 and 9 vials respectively. |
| 7 | Karyotype field during batch creation | **PASS (client-confirmed scope, browser verified)** | Client confirmed that only `NORMAL_STOCK` and `KARYOTYPE_TESTED` classifications are required. Browser checks verified both options and persistence to batches and generated vials. Actual karyotype findings/report fields are explicitly not required. |
| 8 | Search donor by Unit Number during batch creation | **PASS (browser)** | UI searched and selected the registered Unit Number and displayed donor name/blood group. |
| 9 | ART Bank-to-Hospital stock dispatch | **PASS (browser and role scenarios)** | Hospital request, exact vial selection, dispatch, receipt and isolation passed. Insufficient stock was rejected; future-quarantined stock was excluded and API rejected it; Hospital User dispatch returned 403. |
| 10 | Hide ART Bank and Quarantine stock from Hospital Inventory Overview | **PASS (browser)** | Hospital inventory displayed received in-scope vials, excluded a different hospital's vial and omitted ART Bank/quarantine status options. |

## Detailed rule verification

`backend/services/batchRules.js` now centralizes the collection boundary and quarantine eligibility comparisons used by `backend/routes/batches.js`. The focused database-free test command passed:

```text
node backend/test/batch-rules.test.js
5 tests passed, 0 failed

docker compose -f docker-compose.phase1-test.yml run test-runner
154 tests passed, 0 failed
```

The tests verify date parsing, month-end rules, donor interval boundary, quarantine boundary, and vial count/ID generation. The isolated Phase 1 API tests also passed for donor repeat-collection rejection and the eligible boundary date, batch creation, batch release, dispatch, and receipt.

## Dispatch observations

- Hospital users create stock requests scoped to their own assigned hospital and centre.
- The ART Bank dispatch list presents hospital and centre per order. `Select vials` opens candidate selection for that order; there is no independent hospital dropdown in the dispatch modal.
- Candidate pages request `AVAILABLE_AT_ART_BANK` vials and the UI also filters out vials whose quarantine has not ended. The API rechecks status, quarantine, requested blood-group quantities, and claims the vials transactionally.
- The hospital receipt endpoint requires the authenticated hospital/centre to match the order and every vial; receipt changes vial status to `UNUSED_AT_HOSPITAL`.
- API dispatch, rollback/concurrency, and receipt behavior passed in the isolated Phase 1 suite. Phase 3 below adds live browser evidence for dispatch, receipt, insufficient stock, quarantined stock, and unauthorized-role scenarios.

## Test and environment evidence

Passed in this workspace:

- JavaScript syntax checks for the changed rules/routes/tests and frontend workflows.
- `backend/test/batch-rules.test.js`: 5 passed.
- `docker compose -f docker-compose.phase1-test.yml run test-runner`: 154 passed, 0 failed against `parenthood_phase1_test`.
- `backend/test/phase1B-c1-models-services.test.js`: 14 passed.
- `backend/test/phase1B-c2-units.test.js`: 13 passed.
- `backend/test/dependency-security.test.js`: 1 passed.
- `frontend/test-startup.cjs`: passed.

Earlier Phase 2 limitations (the browser-related items were resolved in Phase 3 below):

- At the time of Phase 2, authenticated desktop/mobile screenshots and interactive UI review were untested because no browser automation library/runtime was available. Phase 3 now covers the workflows listed below. Saved production-record review remains out of scope; no production records were queried.
- At the time of Phase 2, insufficient-stock, quarantined-vial, and unauthorized dispatch-role scenarios were not tested. Phase 3 browser/API scenarios below cover these cases.
- No production database, production records, containers, or deployment were accessed or changed.

## Karyotype scope confirmation

The client confirmed that the requirement is limited to these two stock classifications: `NORMAL_STOCK` and `KARYOTYPE_TESTED`. Actual karyotype findings, test dates, report references, or other result fields are not required. Both options and their persistence on batches and generated vials were browser-verified. Existing enum values remain unchanged; no schema change was made.

## Docker Engine access investigation (2026-11-03)

Read-only diagnostics from the current Codex PowerShell session:

- Current identity: `desktop-24jkl1o\admin`. The un-elevated token lists `BUILTIN\Administrators` as **deny only**.
- Docker CLI is installed (`29.9.2`); the selected context is `desktop-linux`, endpoint `npipe:////./pipe/dockerDesktopLinuxEngine`.
- Both the selected `desktop-linux` context and the alternate `default` context fail server access with `permission denied` (`dockerDesktopLinuxEngine` and `docker_engine` pipes respectively); changing contexts does not resolve this session's access problem.
- Docker Desktop and `com.docker.backend` processes are present. This proves the desktop processes started, but does not prove the Linux Engine is ready.
- `docker version` reaches the client but fails on the server call with `permission denied` for the Engine named pipe.
- A read-only Docker version check from an approved elevated tool call connected successfully and reported Docker Desktop 4.97.0 with Linux Engine 29.9.2. This confirms the Engine is running and the access failure is specific to the managed terminal sandbox context.
- The current shell could not inspect the named-pipe ACL (`Get-Acl` could not resolve the pipe as a filesystem path), query the Docker service (WMI returned Access denied), or query WSL (`Wsl/EnumerateDistros ... E_ACCESSDENIED`). `docker desktop status` could not create its local log under `%LOCALAPPDATA%\Docker\log\host` due to Access denied. The `docker-users` local group query returned “The specified local group does not exist” in this environment.

**Assessment:** The immediate cause in this environment was the managed/restricted Codex terminal sandbox blocking Docker named-pipe access. A direct elevated call worked, so Docker Desktop and its Linux Engine were not stopped or missing. This does not establish whether the user's ordinary PowerShell session has the same restriction. No Windows permissions, groups, Docker settings, or database contents were changed.

**Safe next steps in the user's normal Windows session:**

1. Docker Desktop and Engine are currently confirmed running by the successful elevated version check.
2. In the user's normal PowerShell window under the same account, run `whoami`, `docker context show`, and `docker version`. If they fail there too, ask the Windows administrator to inspect Docker Desktop's account/pipe security; do not change ACLs or group membership without approval.
3. In this agent environment, Docker commands that need the Engine must run through an approved elevated tool call; ordinary sandboxed calls still return named-pipe Access denied.

The isolated Phase 1 suite completed with 154 passed and 0 failed tests using `parenthood_phase1_test`. The Compose run left its test-runner container retained with exit code 0 and the `mongo-test` container retained but stopped. Existing local app containers were left unchanged. No production database was accessed.

This report does not claim client acceptance or production readiness.

## Phase 3 - Browser-based acceptance evidence (2026-11-03)

This section supersedes the earlier browser-testing limitations above. The UI was launched locally in Microsoft Edge through the separate `browser-acceptance/` Playwright harness. The harness pins `@playwright/test` 1.64.1 in its own package and does not change frontend/backend dependencies. It uses a per-run random JWT and upload-encryption key and a direct localhost connection to the exact database `parenthood_phase1_test`; it refuses a different database name. The app and browser were accessed only at `127.0.0.1`. No production URL or database was configured.

**Browser result:** `npm test` in `browser-acceptance/` completed **1 browser acceptance test passed, 0 failed** using the installed Microsoft Edge channel. The Phase 3.1 run used unique E2E IDs. Its `afterAll` cleanup verified zero remaining run-owned users, donors, batches, vials, and orders in `parenthood_phase1_test`. The isolated `mongo-test` container was stopped after verification; its container and volume were retained. Passwords used by the test were removed from `.run-state.json` after the run. Audit events are append-only and the harness does not attempt to delete them.

| Workflow / scenario | Status | Browser evidence |
|---|---|---|
| Admin sign-in and dashboard | **PASS** | SUPER_ADMIN login succeeded; desktop dashboard screenshot captured. |
| Donor registration with Unit Number | **PASS** | Completed UI form, verified saved Unit Number and Aadhaar hash in the test DB, then found the donor using the donor list search. Aadhaar input was synthetic test data. |
| Batch Unit Number search and blood-group fill | **PASS** | Search result selected by Unit Number; read-only blood group populated as `O+`. |
| Collection date-only input / future-date validation | **PASS** | Browser observed `type=date`; future date produced the form validation warning. |
| Six-month donor interval | **PASS** | One day before the minimum date was rejected with `DONOR_COLLECTION_INTERVAL`; exact eligibility date was submitted through the UI and saved; one day after was accepted by the browser-authenticated API. |
| Six-month quarantine | **PASS** | Release attempted with future `quarantineEnd` returned `QUARANTINE_ACTIVE`; after advancing only the generated test batch/vial timestamps, the UI release action succeeded. |
| Vial count 3-9 | **PASS (Phase 3.1 browser test)** | The shared input helper now emits an optional native `max` attribute; batch `#bCount` renders `min="3"`, `max="9"`, `step="1"`. In Edge, 2 set `validity.rangeUnderflow=true`, 10 set `validity.rangeOverflow=true`, and 3/9 were valid. UI batch submissions with count 3 and count 9 each succeeded; saved batches contained exactly 3 and 9 vials. Existing JavaScript submission validation and backend rules were retained unchanged. |
| Karyotype classification | **PASS (client-confirmed classification-only scope)** | Browser verified that the form offers `NORMAL_STOCK` and `KARYOTYPE_TESTED`; selecting each value persisted it on the saved batch and all generated vials. Client confirmed actual findings/report fields are not required. |
| Hospital order, ART Bank vial selection and dispatch | **PASS** | Hospital user created a scoped order in the UI. SUPER_ADMIN opened that exact order’s `Select vials` dialog, selected the exact O+ quantities, and dispatch succeeded. Hospital is selected through the order context; there is no separate hospital dropdown in the dispatch modal. |
| Insufficient stock | **PASS (UI rejection)** | A test order requested 4 O+ vials with only 3 eligible E2E vials. Selecting all 3 was rejected in the dispatch dialog with “Select exactly the requested number of vials for every blood group.” |
| Quarantined vial rejection | **PASS (browser-authenticated API)** | A test vial with `AVAILABLE_AT_ART_BANK` status and a future quarantine date was excluded from UI candidates. A dispatch request from the authenticated browser session returned HTTP 400 `VIAL_NOT_AVAILABLE`. |
| Unauthorized dispatch role | **PASS (browser-authenticated API)** | Dispatch request from the authenticated Hospital User session returned HTTP 403 `FORBIDDEN`. |
| Hospital receipt and inventory visibility | **PASS** | Hospital confirmed receipt in the UI; order changed to `RECEIVED`, vials to `UNUSED_AT_HOSPITAL`, and the received vial appeared in the hospital inventory. A vial assigned to a different test hospital was not shown. Hospital status filters omitted `QUARANTINED` and `AVAILABLE_AT_ART_BANK`. |
| Desktop/mobile rendering | **PASS (screenshots captured)** | Desktop 1440×1000 and mobile 390×844 screenshots are listed below. This is a focused workflow review, not a full accessibility audit. |

### Phase 3.1 vial count fix

- `frontend/assets/js/workflows.js`: the generic numeric input renderer now writes `max` when supplied; the batch form already specifies `min: 3`, `max: 9`, and `step: 1`. No API, business rule, schema, or database change was made.
- Browser evidence from the Phase 3.1 run: `#bCount` had native minimum 3 and maximum 9. Counts 2 and 10 were invalid (`rangeUnderflow` and `rangeOverflow`); 3 and 9 were valid. The UI submitted and saved both boundary batches successfully, with 3 and 9 generated vials.
- The full Phase 3 Playwright acceptance test was rerun: **1 passed, 0 failed**. Run-owned records were removed and cleanup counts were asserted as zero. `mongo-test` was stopped without removing its container or volume.

### Phase 3.2 Karyotype scope confirmation

- Client confirmed classification-only scope: `NORMAL_STOCK` and `KARYOTYPE_TESTED` are the only required values. Actual karyotype findings or report fields are not required.
- The browser acceptance test asserts both choices exist. It creates a `KARYOTYPE_TESTED` batch and a `NORMAL_STOCK` batch, then verifies each saved batch and every generated vial retains the selected classification.
- Existing batch/vial enum values were reviewed and left unchanged. No schema changes were made.
- `node backend/test/batch-rules.test.js`: **5 passed, 0 failed**.
- `npm --prefix browser-acceptance test` (Microsoft Edge, isolated `parenthood_phase1_test`): **1 passed, 0 failed**. The harness verified cleanup of run-owned records; the test Mongo container and volume were retained.

### Phase 3 screenshots

Screenshots contain synthetic E2E data only and are saved under `browser-acceptance/artifacts/`:

- [Desktop ART Bank dashboard](browser-acceptance/artifacts/desktop-bank-dashboard.png)
- [Desktop donor registration with Unit Number](browser-acceptance/artifacts/desktop-donor-registration.png)
- [Desktop batch creation](browser-acceptance/artifacts/desktop-batch-creation.png)
- [Desktop vial inventory](browser-acceptance/artifacts/desktop-bank-vial-inventory.png)
- [Desktop dispatch selection](browser-acceptance/artifacts/desktop-dispatch-selection.png)
- [Desktop Hospital dashboard](browser-acceptance/artifacts/desktop-hospital-dashboard.png)
- [Desktop Hospital inventory after receipt](browser-acceptance/artifacts/desktop-hospital-inventory.png)
- [Mobile Hospital dashboard, 390×844](browser-acceptance/artifacts/mobile-hospital-dashboard.png)
- [Mobile Hospital inventory, 390×844](browser-acceptance/artifacts/mobile-hospital-inventory.png)

### Phase 3 environment and remaining limits

- Frontend serves static files from `frontend/`; its API base defaults to same-origin `/api`. The harness serves it on `127.0.0.1:18080` and proxies API calls to the local backend on `127.0.0.1:15001`.
- The database URI is fixed in the harness to `mongodb://127.0.0.1:27018/parenthood_phase1_test?directConnection=true`; both server and test code check `mongoose.connection.name` and fail if it is not `parenthood_phase1_test`.
- Existing isolated Phase 1 integration suite was not rerun in Phase 3; its latest recorded result remains 154 passed, 0 failed.
- The browser test does not establish visual parity across every application page, every role, or every device/browser. It does provide authenticated evidence for the listed workflows and desktop/mobile dashboard/inventory screens.
- No production DB, production data, deployment, commit, or push was accessed or performed. Existing application containers and database records were not reset or deleted.

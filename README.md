# Parenthood ART Bank

The portal is a single Next.js application. The screens and the API run together, and Docker is not used.

## Run it in VS Code

You need Node.js 20.9 or newer and a MongoDB Atlas connection string.

1. Open this folder in VS Code and open a terminal.
2. Install the packages:

```bash
npm install
```

3. Open `.env.local` and set `MONGODB_URI` to your Atlas connection string.
4. Create the first Super Admin (first run only). The username is `superadmin` and the password is `SEED_SUPERADMIN_PASSWORD` from `.env.local`:

```bash
npm run seed:superadmin
```

5. Start the app:

```bash
npm run dev
```

6. Open http://127.0.0.1:3000 in your browser.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the app for development |
| `npm run build` | Build for production |
| `npm start` | Run the production build |
| `npm test` | Run the automated tests against a local replica set, using the database name `parenthood_phase1_test` |
| `npm run preflight:production` | Check production settings without connecting to the database |

## Project layout

| Folder | Contents |
| --- | --- |
| `src/app` | Pages and the `/api` entry point |
| `src/components`, `src/lib` | Shared React components and browser helpers |
| `src/server` | API routes, models, services and tests |
| `scripts` | Administrator and maintenance scripts |
| `docs` | Production runbook and signature rollout guide |

Production deployment steps are in [docs/production-operations.md](docs/production-operations.md).

---

# Change history

The notes below record how the portal's features evolved. Older notes describe the previous separate backend and frontend. Those paths now live under `src/server` and `src/app`.

Yeh README donor registration aur sambandhit workflow changes ka current summary hai. Isme bataya gaya hai ki pehle kya hota tha aur ab kya behavior hai.

## 1. Donor Registration

### Donor ID aur UHID

- Pehle donor listing mein lamba internal Donor ID dikhaya jata tha.
- Ab donor listing/search aur donor-facing workflow mein UHID dikhaya jata hai.
- Internal `donorId` generation aur database relationships abhi bhi waise hi hain. Batches, vials, attachments aur declarations ke existing links break na hon, isliye internal ID ko replace nahi kiya gaya.
- Batch create UHID ya purana `donorId` dono le sakta hai; backend usse existing donor record se resolve karke stored relationship `donorId` se banata hai.
- UHID se donor lookup ke liye authenticated endpoint `/api/donors/uhid/:uhid` add hua hai. Purana `/api/donors/:donorId` endpoint abhi bhi kaam karta hai.

### Height

- Pehle Height ek numeric input tha, centimeters mein, 0.1 increment ke saath. MongoDB mein value string ke roop mein store hoti thi.
- Ab Height text input ke saath quick-pick buttons deta hai: `5.6 ft`, `5.7 ft`, `5.8 ft`, `5.9 ft`, `5.10 ft`, `5.11 ft`, `6.0 ft`. Button click input fill karta hai; doosri height manually type ki ja sakti hai.
- Height `feet.inches` notation mein save hoti hai (`5.8 ft` ka matlab 5 feet 8 inches). Backend is format mein manually entered values aur pehle se maujood historical values accept karta hai.
- MongoDB ka `height` field string hi rehta hai. Existing records ko migrate, normalize, ya rewrite nahi kiya gaya.

### Hataye gaye form fields

- Weight, Consent Status, aur Operational Notes donor registration aur donor detail screen se hata diye gaye.
- Purane donor records ke in fields ke values database schema mein rakhe gaye hain; unhe delete nahi kiya gaya.
- Naye donor create requests mein ye fields persist nahi hote. Historical data preservation ke liye schema fields abhi bhi maujood hain.

### Restricted donor traits

Frontend dropdown aur backend create validation ab in values ko allow karte hain:

- Skin Tone: `Fair`, `Wheatish`
- Eye Color: `Black`, `Brown`
- Hair Color: `Black`, `Brown`
- Build: `Slim`, `Moderate`

Purane records ke values ko change ya delete nahi kiya gaya. Restrictions naye donor registrations par lagu hain.

## 2. Aadhaar aur Declarations

- Full Aadhaar pehle ki tarah store nahi hota; uska verification hash store hota hai.
- Naye donors ke liye masked Aadhaar form (`pehle 2 + masked digits + aakhri 2`) bhi store hota hai, taaki declaration form ise prefill kar sake.
- Couple case select karne par mapped vials se linked donor details dikhte hain. Backend declaration banate waqt mapped vials ke donor ko authoritative source maanta hai; client se aaye donor ID par bharosa karke relationship nahi banata.
- Declaration data mein purana `donor` field internal `donorId` hi rakhta hai. Naya `donorUhid` field UHID deta hai. Isse existing consumers aur tracking dono support hote hain.
- Purane donors ke liye masked Aadhaar value maujood na ho sakti hai, kyunki purana Aadhaar hash se dobara nikala nahi ja sakta. Aise cases mein declaration ke liye first aur last do digits manually bharne hote hain.
- Active authorised signatory ka existing backend flow bana hua hai; declaration create/submit ke samay active signer zaroori hai.

## 3. Collections, Batches, aur Vials

- Pehle Create Batch form document upload aur screening checkboxes maangta tha. Create request mein `batchDate` aur `stockClassification` bhi nahi bheje ja rahe the, jabki backend inhe required maanta tha; is wajah se batch creation fail ho sakta tha.
- Ab collection/batch form document upload ya “Required Screening Passed” input nahi maangta.
- Create request `batchDate` aur selected stock classification bhejti hai. Form `NORMAL_STOCK` aur `KARYOTYPE_TESTED` options deta hai; purane API callers ke liye missing classification par backend default `NORMAL_STOCK` hai.
- Batch create ke saath vials generate hote hain. Donor UHID diya ho to backend use internal donor record se resolve karta hai aur existing `donorId` relationship ke saath batch aur vials save karta hai.
- Vial count 1 se 5 tak hai. Batch ID ka sequence 5 digits ka hota hai; Vial ID mein donor blood group ke ABO letters aur vial number shamil hote hain, jaise `ARTB-2026-00001-O-V01`. Batch date default aaj ki hoti hai; collection date batch date se chhe calendar months pehle default hoti hai aur editable hai. Quarantine end date collection date se kam-se-kam chhe calendar months baad hoti hai; isse pehle ki manual date reject hoti hai aur batch release API chhe mahine poore hone tak stock block rakhti hai.
- Naye batches mein screening/document fields bharna release ki shart nahi hai. Six-month quarantine period poora hone ke baad batch release ho sakta hai.
- Purane batch documents, screening values, aur schema fields delete nahi hue. Batch API ke purane optional fields bhi compatibility ke liye accept hote hain.
- ART Bank vial API responses mein donor UHID milta hai. Hospital responses aur hospital stock export donor, batch aur status-history details omit karte hain.

## 4. Hospital aur Centre User IDs

- Super Admin dedicated hospital-registration form se hospital name, username aur password deta hai. Enter kiya hua username hi account ka login ID aur Hospital ID hota hai; username missing hone par registration reject hota hai. Centre ID username se `CENTRE-<username>` format mein generate hota hai. Normalized duplicate hospital names reject hote hain.
- Generic user-management API bhi named hospital/centre assignments support karta hai. Us flow mein punctuation ya spacing ke karan alag facility names agar ek hi generated ID par resolve hon, to request `HOSPITAL_SCOPE_ID_COLLISION` ke saath reject hoti hai.
- UI mein assigned IDs read-only hain. Backend purane API callers ke `hospitalId`/`centreId` payloads ko abhi bhi support karta hai.
- Purane users ke existing IDs ya scopes ko migrate/change nahi kiya gaya. Jinke records mein full names nahi hain, unka legacy scope save karte waqt preserve hota hai.
- Standalone hospital/centre master CRUD abhi nahi hai. `GET /hospitals` aur `GET /centres` active `HOSPITAL_USER` assignments se options banate hain.

## 5. Hospital Data Access

- Hospital users ke liye backend routes authenticated user ke assigned `hospitalId` aur `centreId` se records scope karte hain.
- Couple, vial, order, dispatch, attachment, declaration, aur report endpoints ke existing backend scope checks preserve kiye gaye hain. Hospital ID ko URL ya request body mein badal dena doosre hospital ka scope nahi deta.
- Hospital inventory, mapping, order, dispatch aur receipt responses donor ID, batch ID aur vial status history expose nahi karte. Donor documents hospital ko sirf tab dikhte hain jab us donor ka vial us hospital/centre ki custody mein ho.
- Donor aur batch master endpoints ART Bank roles tak restricted hain.

## 6. API aur Historical Data Compatibility

- Donor ID generation change nahi hui.
- Existing donor, batch, vial, attachment, declaration, aur user-scope records ko migrate, delete, ya overwrite nahi kiya gaya.
- Existing API routes aur internal relationship fields bane hue hain. UHID lookup, vial `donorUhid`, declaration `donorUhid`, masked Aadhaar, aur hospital/centre names additive data hain.
- Weight, consent, operational notes aur batch screening/document schema fields historical records ke liye model mein maujood hain, chahe naye forms unhe use na karein.

## 7. Abhi Baaki / Dhyan dene wali baatein

- Height quick-pick values 5 ft 6 in se 6 ft tak hain. Is quick-pick range ke bahar valid feet.inches value manually enter ki ja sakti hai.
- Local database available na hone ke karan actual stored Height values ka runtime review nahi hua; historical options runtime par existing donor records se aate hain.
- Demo portal ka screenshot, URL, ya design reference project mein nahi tha, isliye uske saath theme comparison nahi kiya gaya.
- Existing donor records jinmein masked Aadhaar nahi hai, unke liye declaration Aadhaar ke 2+2 digits manually bharne padenge.

## 8. Premium UI Updates

- Sidebar navigation ko role-based horizontal top tabs se replace kiya gaya hai. Active page highlight hota hai aur chhoti screens par tabs horizontally scroll karte hain.
- Vial inventory mein summary counts, search, status, blood group, stock type aur location filters add kiye gaye hain. Clear action saare filters reset karta hai.
- Vial table ab stock classification dikhata hai aur existing status-history action ko retain karta hai.
- Yeh UI-only changes hain; backend routes, API payloads, database schemas aur stored records nahi badle.

## 9. Verification (current workspace)

- Backend/frontend JavaScript syntax checks pass hue.
- Phase 1B-C1 model/service tests: 14 passed, 0 failed.
- Phase 1B-C2 database-free unit/security tests: 12 passed, 0 failed.
- Historical verification note: a prior isolated Phase 1 test runner completed all test files against `parenthood_phase1_test` (145 passed, 0 failed). This is not a rerun against the current final client acceptance changes. Refer to [CLIENT_ACCEPTANCE_REPORT.md](CLIENT_ACCEPTANCE_REPORT.md) for current test results. The earlier suite covered Phase 1A transaction/concurrency routes, donor manual-ID race handling and server-side duplicate lookup, donor-linked batch/vial traceability pagination and restricted-field validation, dispatch candidate pagination, hospital-scoped formula-safe order CSV/PDF exports, streaming exports beyond 10,000 records, streamed couple/patient export, report date validation and UTC date-boundary regressions, role/scope regressions, production-host configuration validation, C2 correction API integration tests, hospital attachment-visibility controls, versioned signature route and concurrency tests on a dedicated test collection, signer update API coverage, signature-index rollout guard tests, current/legacy self-logout revocation, mocked backup/restore-script safety tests, and dependency/startup-safety checks. The runner did not start `server.js` and used only the separately named test replica set; backup/restore and signature-index rollout scripts were not executed in apply mode.
- Targeted dependency security updates now pin Multer 2.5.0, body-parser 1.20.9 and qs 6.16.1. The isolated test environment reported zero production advisories with `npm audit --omit=dev`; its full audit retains two moderate advisories in the development-only nodemon/minimatch chain.
- Production database, application data, live indexes aur containers ko access ya modify nahi kiya gaya.

## 10. Dashboard, Donor Traceability, Reports, and Audit

- ART Bank aur Hospital dashboards ab role-scoped API data se summary cards, pending actions, recent vial activity aur quick links dikhate hain. CEO dashboard current backend ke fail-closed behavior ko follow karta hai; jab tak branch-chain relation configured nahi hai, branch counts/data nahi dikhte.
- Donor detail ab linked collection batches, vials, unke current statuses/locations aur donor Aadhaar attachment ke secured download links dikhata hai. Yeh links existing attachment API ke through download hote hain; database relationships ya authorization scope nahi badla.
- Reports screen date range ke saath existing `/api/reports?from=&to=` endpoint se summary reload kar sakti hai. Stock CSV apne existing export endpoint aur role scope ka use karta hai; selected date range CSV export par lagu nahi hoti.
- Reports page now exposes only verified exports: role-scoped vial stock CSV, role-scoped order/dispatch/receipt CSV and PDF, and Super Admin detailed couple/patient CSV. Declaration and audit CSV rows were removed because no such export endpoints exist. Chain CEO sees an explicit unavailable state while branch scope is unconfigured. Date filters apply to summary cards only.
- Detailed couple/patient CSV now uses a streamed MongoDB aggregation and CSV pipeline, keeping application memory bounded by cursor batches instead of loading all report rows at once. Its role restriction, selected filters, existing columns, blank patient rows for couples without patient records, and audit event are preserved.
- Audit screen action, role, entity aur date range filters ko `/api/audit` endpoint par bhejti hai. Audit records append-only model protections ke saath write hote hain.
## 11. Dashboard visual refresh

- Dashboard ka plain, wide-table feel replace karke workspace header, concise live KPIs, recent stock activity, workflow shortcuts, inventory mix bars aur pending-action panel diya gaya hai.
- Long vial identifiers table mein compact dikhte hain, hover title mein full ID phir bhi available hai. Status codes readable labels aur consistent color indicators mein render hote hain.
- Counts, vial activity aur stock breakdown current API data se calculate hote hain. Kisi sample trend, fake patient record, ya fabricated metric ko add nahi kiya.
- Is refresh mein sirf dashboard frontend presentation badli; role-scoped API calls, backend routes, database aur records unchanged hain.

## 12. Phase 1A and Phase 1B security/workflow work

- Batch creation/release, dispatch, receipt, vial-to-couple mapping, declaration submission/unsubmission, donor/couple creation, signer creation/update/status changes, attachment upload/visibility, signature creation, and login session claims use transaction-backed operations where implemented. Related audit writes participate in the same session. Vial claims use conditional updates to guard competing requests.
- Vial mapping reads couples and vials using the requesting hospital and centre in the database filters. Cross-centre mapping cases passed in the isolated Phase 1A route suite.
- Operational audit metadata uses an allowlist and does not accept full payloads, reasons, Aadhaar values, passwords, tokens or signature contents. AuditLog model mutation paths are guarded as append-only.
- Failed-login audit events do not store an unverified submitted username; known account attempts use the internal user ID, and non-string credential inputs are rejected as invalid credentials.
- Donor creation audit validation now accepts the donor model's existing title-case `Active` status. Previously that audit validation rejected donor creation inside the transaction, causing registration to roll back. A database-free regression test covers the audit event, and the isolated API suite now includes donor registration plus audit verification.
- Audit API responses omit historical `oldValues`, derive summaries from the event code, and project `newValues` to safe allowlisted scalar metadata. Existing stored audit records are not rewritten.
- Frontend inline action arguments derived from API records are JSON-encoded and HTML-escaped before insertion, so attachment filenames and record IDs cannot break out into executable JavaScript.
- Legacy JWTs without a session version are rejected; users with legacy records missing the field resolve to version 1 at runtime.
- Portal logout now calls `POST /api/auth/logout`, conditionally revokes the caller's active session by incrementing `sessionVersion`, and commits a payload-free `LOGOUT_SUCCESS` audit event. It cannot invalidate a newer replacement session, and the UI stays signed in if server revocation fails so the user can retry.
- User creation and updates now reject non-boolean `active` values before persistence. This prevents Mongoose string-to-boolean casting from deactivating an account without clearing its session or incrementing the revocation version. The isolated API suite covers deactivate/reactivate and verifies the old token remains revoked.
- Bank Admin and Staff couple API responses omit partner identity objects. Hospital and Super Admin projections retain those objects under the current permission baseline.
- New hospital couple cases require an Aadhaar number for at least one partner. Aadhaar inputs accept up to 12 digits; saved numbers are masked and hashed, and supporting identity files are optional.
- Couple case IDs now use a short, year-based sequence (`CASE-YYYY-NNNN`) rather than a UUID.
- Couple detail responses apply the same role projection as the list response; a regression case checks bank roles, hospital visibility, and cross-scope denial.
- A scoped stock summary endpoint is available to bank and hospital roles. Chain-to-hospital scope is not modeled; Chain CEO data remains fail-closed/unavailable rather than showing global records.
- Chain CEO dashboard hides inventory totals when scope is unavailable instead of presenting the empty response as a real zero-stock summary.
- Vial, donor, batch, couple, declaration and order list APIs retain their existing array response and add bounded pagination metadata. Hospital record scope is applied to both page results and total counts. These operational pages can load additional records without breaking existing API consumers.
- Dashboard inventory, order and batch badges use scoped/aggregate counts instead of the loaded list subset.
- Dispatch history, attachments, signers, and audit logs now expose bounded pagination metadata while keeping their existing response fields. Donor and vial text search now runs against the full database result set within the caller's role scope; vial status, blood group, stock type and location filters are sent to the API and pagination preserves those filters. Donor UHID lookup remains a bounded search result. Batch lists now search batch/donor IDs and filter the verified `QUARANTINED` and `RELEASED` states on the server, with filtered totals and pagination while retaining the existing array response.
- Dispatch candidate selection now loads eligible vials from the scoped API in pages instead of relying on the first 500 vials previously loaded for the screen. Blood-group matching is case-insensitive for historical value compatibility, and repeated order lines for one blood group are validated as a combined quantity, matching backend dispatch rules.
- Hospital couple mapping now loads `UNUSED_AT_HOSPITAL` vial candidates from the API in pages of 100, so the selector uses the assigned hospital/centre database scope and can reach records beyond the first list page. It labels candidates with donor UHID and leaves eligibility enforcement to the transactional mapping endpoint.
- The shared frontend render dispatcher now sends signed-out sessions to the API login screen and signed-in refreshes through the backend-loaded page renderer. A headless frontend test also exercises scoped vial candidate paging, UHID labels, and selection gating for couple mapping.
- Dispatch remains stored on its Order record (`orderId`, status, courier details, dispatch/receipt actors and timestamps); the API does not define a separate persisted `dispatchId`. The frontend now uses the stable `orderId` and persisted timestamps instead of generating a misleading browser-only `DSP-*` identifier.
- Attachment upload now commits the package, optional batch link/document-verification update, and operational audit event in one MongoDB transaction. Private file storage remains outside the transaction and is cleaned up if the database transaction fails. Attachment visibility changes and their audit events also commit together; downloads are audited through the allowlisted operational audit service.
- ClamAV upload scanning now accepts only the exact NUL-framed `stream: OK` response and fails closed on malformed, infected, error, or oversized scanner replies. A local TCP regression test verifies the accepted clean reply and rejects an error reply containing the substring `OK`.
- ART_BANK_STAFF attachment list, download, and visibility queries now restrict identity-document and donor-Aadhaar packages to the staff member who uploaded them. ART_BANK_ADMIN and SUPER_ADMIN access remains unchanged. Database-free and isolated API regression tests passed.
- Hospital attachment list and download queries exclude submitted `DONOR_AADHAAR` packages while retaining hospital/centre scope and the existing own-upload identity-document behavior. A database-free service test and isolated API regression test cover list and download denial.
- CSV export cells neutralize formula-leading content, including values preceded by whitespace/control characters.
- The vial stock CSV endpoint streams the complete role-scoped result set instead of silently truncating after 10,000 records. Hospital exports continue to omit donor and batch identifiers. A database-free test verifies streaming beyond the old cap and formula-safe cells.
- Route-level failures use generic messages in production so database, storage, and cryptographic exception details are not returned in API responses; development retains diagnostic messages.
- Declaration correction requests are separate from declarations. Hospital users can propose only `date` and `statement`, with a required reason; reviewers are ART_BANK_ADMIN and SUPER_ADMIN. Approval creates a new immutable version and leaves declaration status SUBMITTED. Rejections remain stored as REVISION_REQUIRED; resubmission creates a linked request.
- Legacy declarations without `currentVersion` resolve to version 1 at runtime. No bulk migration was performed. Legacy signatures resolve to version 1 and are not treated as current for a later declaration version.
- Version-bound signature creation, current-signature reads, and transactional historical-signature invalidation are implemented. The app checks index shape and metadata before enabling a corrected version's new signature; otherwise it returns `SIGNATURE_VERSIONING_REQUIRED`. The current isolated application collection still has the legacy unique index, so that route remains fail-closed there.
- The dedicated signature rollout collection test verifies two versioned signatures, competing signing requests, current-signature selection, and history privacy. Production signature indexes and metadata were not inspected or changed.
- The staged index/backfill and mixed-version rollout runbook is documented in [docs/signature-index-rollout.md](docs/signature-index-rollout.md). A read-only preflight was run against only the isolated `parenthood_phase1_test` database; no apply stage was executed.
- Correction APIs and frontend screens are implemented. The declarations page now exposes paginated correction-request history, including rejected requests and their linked resubmissions, through the existing hospital-scoped or bank-review API. The isolated correction API integration tests are included in the latest 145-test run. Production data and deployment behavior remain unverified.
- Donor detail now loads batch and vial traceability through the paginated backend endpoints rather than limiting history to the first pages already loaded for the main lists. The API pagination regression is part of the latest isolated suite.
- Donor duplicate review now queries the complete donor collection by exact case-insensitive name, calendar date of birth and blood group; it returns a bounded list of minimized candidates and keeps the existing user decision to continue registration. Hospital users are denied this bank-only lookup.
- A staged signature metadata/index rollout tool is available at `backend/scripts/migrate-signature-index.js`. It requires exact database confirmation for preflight and separate stage, approval, backup, and paused-write acknowledgements for apply mode. No live or production index changes or metadata backfills were made.
- Declaration version history retains its `data` array response and now includes bounded pagination metadata; the history screen can load further versions without hiding older snapshots.

## 13. Production deployment

Deployment steps, backups and release checks are in [docs/production-operations.md](docs/production-operations.md).

## 14. Verified workflow gates requiring business decisions or isolated integration

- Hospital/centre master data is derived from active hospital-user assignments; no independent master model or CRUD API exists. Before adding one, approve who may create/rename/deactivate facilities, how existing user-derived IDs are reconciled, how facilities link to chains, and what happens to existing records when a facility is deactivated.
- The vial schema declares `CREATED`, `QUARANTINED`, `RELEASED`, `AVAILABLE_AT_ART_BANK`, `DISPATCHED`, `UNUSED_AT_HOSPITAL`, `RETURNED_BEFORE_MAPPING`, `MAPPED_USED`, `BLOCKED`, `RECALLED`, `DISCARDED`, and `EXPIRED`. Verified route transitions are batch release (`QUARANTINED` to `AVAILABLE_AT_ART_BANK`), order dispatch (`AVAILABLE_AT_ART_BANK` to `DISPATCHED`), receipt (`DISPATCHED` to `UNUSED_AT_HOSPITAL`), couple mapping (`UNUSED_AT_HOSPITAL` to `MAPPED_USED`), and the administrator block/recall transitions in `backend/routes/vials.js`; the vial inventory exposes these same block/recall actions only to `SUPER_ADMIN` and `ART_BANK_ADMIN`. No implemented route transition into `RETURNED_BEFORE_MAPPING`, `DISCARDED`, or `EXPIRED` was found. Return eligibility, disposal authorization/reason, expiry source/time rule, and recall handling require business approval before implementation.
- `backend/models/Patient.js` defines a Patient record, and the detailed couple export in `backend/routes/reports.js` reads Patient documents. No patient CRUD route or patient frontend workflow was found. Confirm whether patient records should be created independently, whether couple subdocuments remain authoritative, and which approved identity/demographic fields and role access rules apply before exposing a patient API.
- The declaration correction screen is now the effective `declarations()` renderer; an older duplicate demo renderer was renamed to avoid shadowing it. Versioned signature re-use remains gated on the separate signature-index rollout documented above.
- Donor, batch, couple, vial, declaration, order, user, dispatch-history, attachment, signer, and audit lists expose bounded offset pagination. This preserves the existing array fields and adds pagination metadata; insertion during offset-based browsing can still shift page boundaries. A future keyset cursor design may be warranted at larger scale.
- The isolated test runner completed 145 tests with 0 failures against `parenthood_phase1_test`. This does not replace the production preflight, real backup/restore proof, business approvals, signature-index rollout, or deployment acceptance gates above.
- The latest production configuration preflight was executed without starting the API; it reported missing `PORTAL_HOST` and template values for `MONGODB_URI` and `CLIENT_ORIGIN`. It did not print their values or connect to a database. Supply the real hostname and replace template values only through approved deployment configuration, then rerun the preflight.

## 15. Donor and hospital workflow updates (2026-11-14)

These updates implement the latest clarified donor, stock, hospital-registration, declaration, and attachment requirements. Existing records are retained; no production-data operation is part of this change.

1. **Donor registration:** Unit Number is removed from the registration form and is optional for new API records; legacy values remain available for historical records. Donor age is limited to 21–55 years. Manual donor ID remains limited to 50 characters.
2. **Vials and quarantine:** Batch vial count is restricted to 1–5. Batch ID sequences use exactly five digits; vial IDs include the donor blood group's ABO letters and a vial number (for example, `ARTB-2026-00001-O-V01`). Batch date defaults to today, and the editable collection date defaults to six calendar months before that batch date. The quarantine end date remains at least six calendar months after collection; earlier manual dates and early release are rejected. Donor repeat-collection eligibility remains a separate six-month rule.
3. **Pending hospital stock:** ART Bank can select a donor when preparing a hospital stock order. Dispatch validates that selected vials belong to that donor and are released, available, and in the requested blood groups.
4. **Hospital registration:** Super Admin registration generates the login username, Hospital ID, and Centre ID from the hospital name and rejects duplicate normalized hospital names.
5. **Hospital privacy:** Hospital inventory, mapping, order, dispatch, and receipt responses omit donor ID, batch ID, and vial status history. Donor master and batch details remain ART Bank-only.
6. **Declarations:** The donor number is derived from the donor linked to the couple's mapped vials. The printable declaration follows the supplied sample's patient metadata and donor-trait table; optional supporting files upload as private donor documents and remain linked to that donor.
7. **Donor documents:** Hospital access is limited to submitted donor documents for donors with vials in that hospital/centre's custody.

**Verification:** The isolated backend suite passed 164 tests, including 56 Phase 1A API tests. Batch-rule tests passed 5/5, and the frontend startup check passed. The full historical browser acceptance report below predates these follow-up requirements; no new authenticated browser session was run. TypeScript typecheck is not configured because the frontend is plain JavaScript.

## 16. Historical client acceptance verification

[CLIENT_ACCEPTANCE_REPORT.md](CLIENT_ACCEPTANCE_REPORT.md) records the earlier 2026-11-03 browser and API acceptance work. Its Unit Number, 21–50 age, and 3–9 vial-count results are historical and are superseded by the 2026-11-14 workflow updates in Section 15. The latest isolated backend run passed 164 tests, but no new authenticated browser acceptance was run for these follow-up changes. This report does not establish client acceptance or production readiness.

## 17. Next.js migration (2026-11-18)

- The Express API moved into Next.js with its routes, permission checks and transactions preserved.
- All screens were rewritten as React pages, and Docker and Nginx configuration was removed.
- Registering a hospital no longer fails on the audit log's `ceoLinked` field.
- The Edit scope dialog on the Users page works again.
- Hospitals can request declaration corrections, and ART Bank admins can review them on the Declarations page.
#   P a r e n t h o o d - A R T - B A N K  
 
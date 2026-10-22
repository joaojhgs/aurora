# V284: retain hosted mesh success attachments

## Finding

The installed Playwright JSON reporter is sufficient; no test/spec or compiled UI change is needed. The current hosted config selects only `line` (`tests/e2e/hosted_peer/playwright.config.ts:23`), which does not write the `testInfo.attach` buffers on success. The maintained runner already forwards extra CLI args to Playwright (`scripts/hosted_peer_e2e.sh:945-948`), so a one-run CLI override can retain the successful summaries.

Installed `@playwright/test` and `playwright` are version **1.61.1**. The installed runner documents `--reporter` as comma-separated built-in reporter names (`node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/lib/program.js:117`). The JSON reporter reads `PLAYWRIGHT_JSON_OUTPUT_FILE` via `resolveOutputFile` (`lib/runner/index.js:1493-1511`) and serializes each result's attachments as `{name, contentType, path, body}` with `body` base64 (`lib/runner/index.js:4022-4042`). The worker converts string `testInfo.attach({body})` into a Buffer (`lib/worker/workerProcessEntry.js:113-131`), sends it as base64 (`:1217-1223`), and the runner reconstructs it (`lib/runner/index.js:252-260`). The maintained Assistant spec uses string JSON bodies for the safe summaries (`tests/e2e/hosted_peer/hosted-peer-live-shell.spec.ts:218-269` and failure summaries later in the file).

## Root-owned invocation

For the already-approved next pilot only, set the existing artifact directory to a private run-owned path and pass the reporter override through the existing script:

```bash
umask 077
AURORA_HOSTED_PEER_LIVE_SHELL_ACCEPTANCE=1 \
AURORA_HOSTED_PEER_ARTIFACT_DIR="$PRIVATE_ARTIFACT_DIR" \
PLAYWRIGHT_JSON_OUTPUT_FILE="$PRIVATE_ARTIFACT_DIR/playwright-report.json" \
scripts/hosted_peer_e2e.sh --reporter=line,json
```

The output is created by Playwright in the same private directory; the invocation keeps the existing line display and adds JSON attachment retention. The caller must set `PRIVATE_ARTIFACT_DIR` to the existing approved artifact location. No old successful main should be repeated just to capture metrics.

## Safe extraction

Treat the full JSON file as sensitive: Playwright also serializes stdout, stderr, errors, and other attachments without sanitizing them. Keep it private (the `umask` above produces owner-only files under the default creation mode). A small offline parser can walk `suites[].specs[].tests[].results[]`, select only result attachments named `assistant-main-safe-summary.json` or `assistant-main-backend-safe-summary.json` with `contentType === "application/json"` and a `body`, base64-decode and parse those bodies, then project only the pre-approved finite measurement keys. Do not print or publish the complete report or any unprojected body/log/error fields. Check that the selected test result status is `passed`; preserve its run association and hashes in the external private measurement record. This route retains the existing successful safe attachment buffers without changing the accepted test or product.

## Source hashes

| Source | SHA256 |
|---|---|
| `tests/e2e/hosted_peer/playwright.config.ts` | `a4ce9cec6c0877126a99eb91318f42f5a11481fec8b3abc637e4a976aa547aeb` |
| `scripts/hosted_peer_e2e.sh` | `36d9e2907d9f19590f3552d2ea2aefad27cdb6f2c09d8e2cdfac748dccf0a267` |
| `tests/e2e/hosted_peer/hosted-peer-live-shell.spec.ts` | `a257aa79f03423fa412ffa53099f124910c248a3c3591924e9e3688de0891b2b` |
| installed Playwright `lib/runner/index.js` | `42772378ebad5d2387726d02d377721112edbdde99d495c1259855ddb701b08e` |
| installed Playwright `lib/worker/workerProcessEntry.js` | `e8b654850c073df3996816eb09edf845490d9a6e75785477a9ddb69d586cca54` |
| installed Playwright `types/test.d.ts` | `6e8044a9ca35eb66823c9ddddf826ca28bf900cd0cb3d31b3007277d094dc21e` |

No execution, browser, model, build, or test run was performed. This is source-local reporter evidence and an invocation recommendation, not measurement data or a successful pilot result.

# V764 CPU-finalizer current-schema correction closure

APPROVE source only for canonical worker-cpu-v737/post_terminal.py SHA `1b9ef010c8c83dfab6f3a77f1da85a2238ec6a7d04c72465cd8ea91bb32c2150`. This closes exactly the three V763 findings; original REQUEST_CHANGES report is preserved unchanged. Prior source-positive terminal/admission/privacy/publication checks remain closed.

1. Manifest producer and saved-member audit now consistently use exportSHA256 and retain exact digest comparison.
2. Native boundaries accept actual observer decimal-string/int timestamps, reject booleans/unparsable values, and require nonnegative ordered values within the same actual PID/recorder/clock/stage/span/correlation pair before subtraction. No cross-clock duration or inferred zero is added.
3. Actual unique attempt correlation IDs now resolve the case; duplicate attempt correlations fail. Native absent harness labels remain nativeHarnessCaseId=null with explicit caseBindingSource=unique_actual_correlation_id_to_attempt and missingNativeHarnessCaseId counts. If a native label exists it must match; measured histories still exclude warmups. This joins the actual CPU observer schema without fabricating emitted IDs.

Retained Root parser fixture receipt `thesis/validation/cpu-finalizer-parser-main-v764.json` SHA `4e738d8504720c3d45128e25f7b538acda5851571b8824e3503e0fe493b7b5a9` reports exit0/0.049114s for one pure synthetic1-warmup+1-measured/5-handler/12-boundary flow shaped like the real observer. It confirms parser behavior only: no real raw-data read, archive audit, finalization, service/model or new measured request. The unchanged default opt-in refusal receipt remains limited to refusal behavior; no repeat is requested. This reviewer ran no parser/tests/imports/runtime or other executable validation.

Actual CPU natural terminal, exact owner absence, CPU global lock/resource/frozen-input admission and the ONE real saved-data audit remain future Root gates. No900 outcome, native metric values, archive/publication acceptance, physical audio/GPU/desktop-DB or whole-goal claim follows. Source read plus small receipt/hash inspection only; this mode0600 report is the sole write.

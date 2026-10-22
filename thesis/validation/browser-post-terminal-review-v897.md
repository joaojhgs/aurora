# V897 narrow source closure

APPROVE — V893 owner-gate batch closed, source only.

Reviewed V896 post_terminal.py SHA256 `a0cfe99fc2d1348ba078b1d11adbdad081921accb3ce8ee094873203ae54f6c9`; PREP SHA256 `cec6e01ca66da78cb0265543c7525920b4dd7e5671efc72cc1067a39f6bf56e0`.

Exact comparison with preserved V888 confirms only the requested retirement changes: every ownedProcessIdentities row must carry positive integer PID/startTicks, and every PID joins the fresh absence set, including browser descendants. That complete set is returned to the existing post-lock absence check. The original spawn PID/frozen hash guard now additionally requires its actual string/integer startTicks representation to equal74502600. These checks establish the previously missing identity binding and complete owner absence precondition; no signal, lock removal or workload action was added.

All other V893 source-positive paths/limitations are reused without a second review. Unused export-v888 and retirement-v888 exclusive destinations remain intentional one-shot outputs. AST parsing passed through standard-library source inspection; no candidate/Aurora imports, runtime, saved audit, tests, browser/model/build/device/network/Orca actions or other source/canonical/Git changes occurred. V888 and V893 history remain preserved.

Actual natural terminal, exact owner absence, free locks/storage and the single future saved archive/outcome audit remain Root gates. This approval does not establish a seal, benchmark result or physical audio acceptance.

# Aurora Tauri UI Visual Refinement Handoff

**Date:** 2026-07-03  
**Branch / commit baseline:** `feat/ui-multi-platform-integration` at `72aade3`  
**Primary UX source of truth:** `modules/ui-mock-reference`  
**Current production app:** `apps/aurora-tauri` using `packages/aurora-ui`  
**Visual artifacts:** `.omx/artifacts/visual-ralph/all-pages-final/`

This handoff is for the next agent refining the Aurora Tauri/web/mobile UI. The goal is not to invent a new design. The goal is to keep pushing every production page toward the dark, dense, technical cockpit shown in `modules/ui-mock-reference`, while preserving truthful Aurora SDK/Gateway/platform behavior.

## Design read

Read this UI as a **privacy-first technical operator cockpit and assistant console** for local AI infrastructure users. It should feel like the mock: dark, compact, information-dense, shadcn-adjacent, teal-accented, terminal/operator-grade, and responsive. It should not feel like a generic SaaS dashboard, a debug panel, or a task/evidence report.

Recommended dials for future work:

- `DESIGN_VARIANCE: 5` - disciplined, not experimental.
- `MOTION_INTENSITY: 2` - mostly static, subtle state feedback only.
- `VISUAL_DENSITY: 9` - dense cockpit, compact tables/cards, minimal wasted whitespace.

Hard visual constraints:

- Preserve the mock's dark base, teal accent, compact cards, left nav, right context rail, and mobile bottom-nav behavior.
- Do not expose task/provenance/debug language in visible production UI.
- Do not claim unsupported native capabilities.
- Demo/fixture mode must be clearly labeled as demo only.
- Keep route-state truth from Aurora SDK/Gateway; do not replace real state with prettier fake data.
- Every page must remain route-specific and production-facing.

## Current visual evidence

The current Visual Ralph capture compared mock and production pages at desktop `1440x1024` and mobile `390x844`.

Contact sheets:

![Desktop routes A](../.omx/artifacts/visual-ralph/all-pages-final/contact-desktop-a.jpg)

![Desktop routes B](../.omx/artifacts/visual-ralph/all-pages-final/contact-desktop-b.jpg)

![Mobile routes A](../.omx/artifacts/visual-ralph/all-pages-final/contact-mobile-a.jpg)

![Mobile routes B](../.omx/artifacts/visual-ralph/all-pages-final/contact-mobile-b.jpg)

If these local artifacts are missing, regenerate them with the command block in [Reproduction commands](#reproduction-commands).

## Route inventory and source mapping

| ID | Production route | Mock route | Primary production files | Mock/source references | Screenshot evidence |
| --- | --- | --- | --- | --- | --- |
| assistant | `/` | `/` | `packages/aurora-ui/src/assistant-view.tsx`, `route-sheet.tsx`, `tool-approval-panel.tsx`, `apps/aurora-tauri/src/tauri-app.tsx` | `modules/ui-mock-reference/components/aurora/app-shell.tsx`, `components/aurora/assistant/assistant-view.tsx`, `components/aurora/assistant/route-sheet.tsx`, `components/aurora/assistant/tool-call-card.tsx` | `desktop-prod-assistant.png`, `mobile-prod-assistant.png`, `desktop-mock-assistant.png`, `mobile-mock-assistant.png` |
| memory | `/memory` | `/memory` | `packages/aurora-ui/src/memory-view.tsx` | `modules/ui-mock-reference/app/(cockpit)/memory/page.tsx` | `desktop-prod-memory.png`, `mobile-prod-memory.png`, `desktop-mock-memory.png`, `mobile-mock-memory.png` |
| tools | `/tools` | `/tools` | `packages/aurora-ui/src/tool-approval-panel.tsx`, tools route content in `apps/aurora-tauri/src/tauri-app.tsx` | `modules/ui-mock-reference/app/(cockpit)/tools/page.tsx`, `components/aurora/assistant/tool-call-card.tsx` | `desktop-prod-tools.png`, `mobile-prod-tools.png`, `desktop-mock-tools.png`, `mobile-mock-tools.png` |
| mesh | `/mesh` | `/mesh` | `packages/aurora-ui/src/mesh-peers-view.tsx` | `modules/ui-mock-reference/components/aurora/mesh/mesh-view.tsx` | `desktop-prod-mesh.png`, `mobile-prod-mesh.png`, `desktop-mock-mesh.png`, `mobile-mock-mesh.png` |
| admin | `/admin` | `/admin` | `packages/aurora-ui/src/admin-overview-view.tsx` | `modules/ui-mock-reference/components/aurora/admin/overview.tsx` | `desktop-prod-admin.png`, `mobile-prod-admin.png`, `desktop-mock-admin.png`, `mobile-mock-admin.png` |
| admin-services | `/admin/services` | `/admin/services` | `packages/aurora-ui/src/admin-services-view.tsx` | `modules/ui-mock-reference/components/aurora/admin/services-view.tsx` | `desktop-prod-admin-services.png`, `mobile-prod-admin-services.png`, `desktop-mock-admin-services.png`, `mobile-mock-admin-services.png` |
| admin-access | `/admin/access` | `/admin/access` | `packages/aurora-ui/src/admin-rbac-view.tsx` | `modules/ui-mock-reference/components/aurora/admin/rbac-view.tsx` | `desktop-prod-admin-access.png`, `mobile-prod-admin-access.png`, `desktop-mock-admin-access.png`, `mobile-mock-admin-access.png` |
| admin-tokens | `/admin/tokens` | `/admin/tokens` | `packages/aurora-ui/src/admin-tokens-view.tsx` | `modules/ui-mock-reference/components/aurora/admin/tokens-view.tsx` | `desktop-prod-admin-tokens.png`, `mobile-prod-admin-tokens.png`, `desktop-mock-admin-tokens.png`, `mobile-mock-admin-tokens.png` |
| admin-devices | `/admin/devices` | `/admin/devices` | `packages/aurora-ui/src/admin-devices-view.tsx` | `modules/ui-mock-reference/components/aurora/admin/devices-view.tsx` | `desktop-prod-admin-devices.png`, `mobile-prod-admin-devices.png`, `desktop-mock-admin-devices.png`, `mobile-mock-admin-devices.png` |
| admin-config | `/admin/config` | `/admin/config` | `packages/aurora-ui/src/admin-config-view.tsx`, `config-editor-view.tsx` | `modules/ui-mock-reference/components/aurora/admin/config-view.tsx` | `desktop-prod-admin-config.png`, `mobile-prod-admin-config.png`, `desktop-mock-admin-config.png`, `mobile-mock-admin-config.png` |
| admin-contracts | `/admin/contracts` | `/admin/contracts` | contracts route content in `apps/aurora-tauri/src/tauri-app.tsx`, `packages/aurora-ui/src/production-surface-contracts.ts` | `modules/ui-mock-reference/components/aurora/admin/*` for admin shell/table language | `desktop-prod-admin-contracts.png`, `mobile-prod-admin-contracts.png`, `desktop-mock-admin-contracts.png`, `mobile-mock-admin-contracts.png` |
| admin-plugins | `/admin/plugins` | `/admin/plugins` | plugins route content in `apps/aurora-tauri/src/tauri-app.tsx` | admin mock card/table language under `modules/ui-mock-reference/components/aurora/admin/*` | `desktop-prod-admin-plugins.png`, `mobile-prod-admin-plugins.png`, `desktop-mock-admin-plugins.png`, `mobile-mock-admin-plugins.png` |
| admin-pairing | `/admin/pairing` | `/admin/pairing` | `packages/aurora-ui/src/pairing-queue-view.tsx` | admin pairing/mock shell language under `modules/ui-mock-reference/components/aurora/admin/*` | `desktop-prod-admin-pairing.png`, `mobile-prod-admin-pairing.png`, `desktop-mock-admin-pairing.png`, `mobile-mock-admin-pairing.png` |
| admin-backups | `/admin/backups` | `/admin/backups` | `packages/aurora-ui/src/backup-restore-view.tsx` | admin backup/mock shell language under `modules/ui-mock-reference/components/aurora/admin/*` | `desktop-prod-admin-backups.png`, `mobile-prod-admin-backups.png`, `desktop-mock-admin-backups.png`, `mobile-mock-admin-backups.png` |
| admin-scheduler | `/admin/scheduler` | `/admin/services` | `packages/aurora-ui/src/admin-scheduler-view.tsx` | service table density from `modules/ui-mock-reference/components/aurora/admin/services-view.tsx` | `desktop-prod-admin-scheduler.png`, `mobile-prod-admin-scheduler.png`, `desktop-mock-admin-scheduler.png`, `mobile-mock-admin-scheduler.png` |
| admin-audit | `/admin/audit` | `/admin/audit` | `packages/aurora-ui/src/admin-audit-view.tsx` | `modules/ui-mock-reference/components/aurora/admin/audit-view.tsx` | `desktop-prod-admin-audit.png`, `mobile-prod-admin-audit.png`, `desktop-mock-admin-audit.png`, `mobile-mock-admin-audit.png` |
| models | `/models` | `/models` | `packages/aurora-ui/src/models-view.tsx` | `modules/ui-mock-reference/components/aurora/models/models-view.tsx` | `desktop-prod-models.png`, `mobile-prod-models.png`, `desktop-mock-models.png`, `mobile-mock-models.png` |
| diagnostics | `/diagnostics` | `/diagnostics` | `packages/aurora-ui/src/mesh-diagnostics-view.tsx`, `mesh-diagnostics-resource.tsx` | `modules/ui-mock-reference/components/aurora/diagnostics/diagnostics-view.tsx` | `desktop-prod-diagnostics.png`, `mobile-prod-diagnostics.png`, `desktop-mock-diagnostics.png`, `mobile-mock-diagnostics.png` |
| onboarding | `/onboarding` | `/onboarding` | `packages/aurora-ui/src/onboarding-view.tsx` | `modules/ui-mock-reference/components/aurora/onboarding/onboarding-view.tsx` | `desktop-prod-onboarding.png`, `mobile-prod-onboarding.png`, `desktop-mock-onboarding.png`, `mobile-mock-onboarding.png` |
| settings | `/settings` | `/settings` | `packages/aurora-ui/src/settings-permissions-view.tsx` | `modules/ui-mock-reference/components/aurora/settings/settings-permissions-view.tsx` | `desktop-prod-settings.png`, `mobile-prod-settings.png`, `desktop-mock-settings.png`, `mobile-mock-settings.png` |
| memory-policy | `/memory/policy` | `/memory` | `packages/aurora-ui/src/data-policy-view.tsx` | memory/data density from `modules/ui-mock-reference/app/(cockpit)/memory/page.tsx` | `desktop-prod-memory-policy.png`, `mobile-prod-memory-policy.png`, `desktop-mock-memory-policy.png`, `mobile-mock-memory-policy.png` |
| settings-native | `/settings/native` | `/settings` | `packages/aurora-ui/src/settings-native-view.tsx`, `platform-surface.ts` | native/settings density from `modules/ui-mock-reference/components/aurora/settings/settings-permissions-view.tsx` | `desktop-prod-settings-native.png`, `mobile-prod-settings-native.png`, `desktop-mock-settings-native.png`, `mobile-mock-settings-native.png` |

All screenshot paths above are relative to `.omx/artifacts/visual-ralph/all-pages-final/`.

## Current implementation state

The latest pass made the full UI family visually coherent:

- shared dark radial page background and dense cockpit card treatments in `packages/aurora-ui/src/styles.css`;
- compact page headers, badges, tables, panels, inputs, action rows, and AdminAction blocks;
- mobile one-column layouts with badge clusters collapsed/hidden where they previously overflowed;
- production status language normalized in `status-badges.tsx`;
- visible labels cleaned from raw backend/provenance terms, e.g. `capability_not_advertised` -> `Unavailable`, `mock` -> `Demo`, `Generated parameter form` -> `Tool parameters`;
- long AdminAction route-state labels shortened for mobile;
- visual regression fingerprints updated in `packages/aurora-ui/tests/accessibility-responsive-visual.test.tsx`.

The UI now looks much closer to the mock across the route family. It is still not pixel-identical because production pages surface real Aurora contracts, unavailable capabilities, Gateway route state, AdminAction constraints, and platform limits. Keep that truthfulness.

## Route-by-route refinement notes

Use the contact sheets first, then inspect the individual route screenshots. Recommended next refinements:

### Assistant `/`

Current state is one of the strongest pages. Preserve its chat-first structure, message density, route/privacy sheet, tool cards, and composer layout. Only refine if another page needs shared shell changes.

### Memory `/memory`

Production page is visually coherent but has more explanatory copy than the mock. Next agent should reduce header/body text density, strengthen the memory-summary card hierarchy, and make search/result cards closer to the mock's compact metric-and-list rhythm.

### Tools `/tools`

Production tools page is functional but still more form-heavy than the mock. Keep real schema validation/AdminAction behavior, but improve visual grouping: catalog list, selected tool detail, parameter form, dry-run, and approval state should read as one dense tool-workbench surface rather than separate verbose panels.

### Mesh `/mesh`

Production mesh page has correct data truth but differs from mock card rhythm. Tighten peer cards and transport metrics; reduce prose; increase compact table/list treatment where possible. Preserve demo labeling when peer data is fixture/sample.

### Admin overview `/admin`

Production overview is aligned enough but could use stronger mock-like status-card rhythm. Avoid generic dashboard feel. Keep AdminAction/security warnings visually intentional, not alarm-banner heavy unless truly blocking.

### Services `/admin/services`

Production service data is route-specific and truthful. It is more card-based than the mock service table. If refining, bring back a denser row/table language while preserving service controls and Gateway readiness details.

### Access/RBAC `/admin/access`

Current production page is solid but visually more stacked than the mock. Improve by making principals/roles/permissions feel like a compact admin matrix. Keep AdminAction confirm flows distinct.

### Tokens `/admin/tokens`

Mobile is now acceptable. Further refine token status pills, scope rows, and issuance/revocation forms to feel like the mock's dense security console. Avoid exposing raw token/secret material.

### Devices `/admin/devices`

Good candidate for another detail pass: use denser session/device rows and clearer active/revoked/suspicious grouping. Preserve credential/privacy states.

### Config `/admin/config`

Current view is production-safe but can still feel too form-heavy. Next pass should make config sections closer to the mock accordion/list style and improve staged-change review hierarchy. Never bypass AdminAction review.

### Contracts `/admin/contracts`

Route has real registry content and a dense table. Further refine sorting/filter controls and contract detail expansion styling. Keep Gateway/OpenAPI path labels production-facing; do not reintroduce `generated` wording.

### Plugins `/admin/plugins`

Could use stronger mock parity. Make plugin/MCP/tool rows more card-table hybrid, with clear enabled/available/unsupported states. Keep unsupported capabilities honest.

### Pairing `/admin/pairing`

Mobile label overflow was fixed. Further refine pairing queue rows and exchange details; reduce explanatory prose. Keep AdminAction and credential-state boundaries clear.

### Backups `/admin/backups`

This remains one of the more text-heavy production pages. Refine into compact backup cards, availability rows, and restore action panels. Keep warnings visible but not visually sloppy. Never imply backup create/restore works when backend capability is unavailable.

### Scheduler `/admin/scheduler`

Uses service-table mock as closest reference. Improve job table density and action grouping; reduce vertical whitespace in job forms; keep AdminAction confirm flow.

### Audit `/admin/audit`

Good admin-table candidate. Tighten filters, event rows, and receipt/status details to match mock audit table language. Keep sensitive/redacted data boundaries.

### Models `/models`

Current page is visually coherent but has a lot of operational detail. Align more closely with the mock's provider cards and model health grid. Keep no-model/fallback/local-vs-cloud states truthful.

### Diagnostics `/diagnostics`

Production diagnostics intentionally differs from mock because it exposes support bundle, probes, redaction, and platform state. Keep it dense and technical, but reduce wordy panels and make redaction/probe status cards more scan-friendly. Keep `updated`/`not reported` production wording, not `generated`/evidence wording.

### Onboarding `/onboarding`

Current page is workable. Next pass should make the setup steps feel more like mock onboarding cards with clearer progress and smaller explanatory blocks. Keep desktop/web/mobile mode truth.

### Settings `/settings`

Current settings page is decent. Refine toggles, capability rows, and permission cards to better match mock settings. Do not show unsupported native controls on web/mobile modes unless clearly disabled/unsupported.

### Data policy `/memory/policy`

Uses memory mock as closest reference but production content is specialized. This page is still verbose. Refine into concise retention metrics, namespace policy cards, redaction/audit rows, and compact explanations. Preserve privacy and retention truth.

### Native settings `/settings/native`

Uses settings mock as closest reference but production content is specialized. Keep platform behavior honest: desktop local can show native controls; desktop thin/web/mobile thin should show unsupported or remote-limited states. Improve mobile compactness and reduce prose.

## Shared styling and token areas to inspect first

Most all-page visual changes currently live as a final override pass in:

- `packages/aurora-ui/src/styles.css`

Before touching individual pages, inspect the bottom of this file for the current Visual Ralph all-route pass. The next agent should prefer consolidating/cleaning shared selectors only after locking behavior with tests. Avoid per-route ad hoc CSS unless the route truly has a unique layout need.

Important shared files:

- `packages/aurora-ui/src/shell.tsx` - global shell, nav, route frame.
- `packages/aurora-ui/src/nav.tsx` - the 22 route inventory and capability metadata.
- `packages/aurora-ui/src/status-badges.tsx` - production label normalization.
- `packages/aurora-ui/src/state-surface.tsx` - loading/empty/error/offline/permission state surfaces.
- `packages/aurora-ui/src/platform-surface.ts` - desktop/web/mobile/native platform truth helpers.
- `packages/aurora-ui/src/production-surface-contracts.ts` - route production-surface oracle strings.

## Production wording rules

Keep these replacements and avoid regressions:

| Avoid visible wording | Preferred production wording |
| --- | --- |
| `Generated` / `generated` for UI provenance | `Updated`, `Gateway route`, `SDK route`, `Tool parameters`, `Route registry` |
| `EVIDENCE`, `Runtime snapshot`, task/proof language | `Status`, `State`, `Diagnostics`, `Support bundle` |
| raw `mock` route-state label | `Demo` or `Demo mode` |
| raw `capability_not_advertised` | `Unavailable` |
| raw backend codes without context | user-facing state label plus detail only where useful |
| `debug-dashboard`, raw route dump, placeholder | never visible in production routes |

Tests already guard many of these. Expand those tests rather than relying on manual review.

## Responsive/platform requirements

Future refinements must test at least:

- Desktop: `1440x1024`
- Mobile: `390x844`
- Tablet if layout changes materially: `768x1024`

Platform truth to preserve:

- Desktop Tauri local: can show local sidecar/Gateway/native controls when available.
- Desktop Tauri thin: remote Gateway behavior, no fake local sidecar control.
- Web browser: no unsupported native claims.
- Android/iOS Tauri/mobile thin: use mobile-safe layouts and only show native features actually supported for that mode.
- Offline/demo mode: clearly labeled as demo/fixture, never implied live.

## Reproduction commands

Start both visual targets from repo root if not already running:

```sh
pnpm --filter @aurora/tauri-ui dev -- --host 127.0.0.1
pnpm --dir modules/ui-mock-reference dev -- --hostname 127.0.0.1 --port 3333
```

If the actual scripts differ, use the repo's current package scripts. The latest successful screenshot run used:

- production: `http://127.0.0.1:1420`
- mock: `http://127.0.0.1:3333`

Route map:

```sh
cat > /tmp/aurora-route-map.tsv <<'ROUTES'
assistant	/	/
memory	/memory	/memory
tools	/tools	/tools
mesh	/mesh	/mesh
admin	/admin	/admin
admin-services	/admin/services	/admin/services
admin-access	/admin/access	/admin/access
admin-tokens	/admin/tokens	/admin/tokens
admin-devices	/admin/devices	/admin/devices
admin-config	/admin/config	/admin/config
admin-contracts	/admin/contracts	/admin/contracts
admin-plugins	/admin/plugins	/admin/plugins
admin-pairing	/admin/pairing	/admin/pairing
admin-backups	/admin/backups	/admin/backups
admin-scheduler	/admin/scheduler	/admin/services
admin-audit	/admin/audit	/admin/audit
models	/models	/models
diagnostics	/diagnostics	/diagnostics
onboarding	/onboarding	/onboarding
settings	/settings	/settings
memory-policy	/memory/policy	/memory
settings-native	/settings/native	/settings
ROUTES
```

Capture all screenshots and contact sheets:

```sh
rm -rf .omx/artifacts/visual-ralph/all-pages-final
mkdir -p .omx/artifacts/visual-ralph/all-pages-final
while IFS=$'\t' read -r id prod mock; do
  for pair in 'desktop 1440,1024' 'mobile 390,844'; do
    vp_id=${pair%% *}; size=${pair#* }
    pnpm exec playwright screenshot --viewport-size="$size" "http://127.0.0.1:1420$prod" ".omx/artifacts/visual-ralph/all-pages-final/${vp_id}-prod-${id}.png" >/dev/null
    pnpm exec playwright screenshot --viewport-size="$size" "http://127.0.0.1:3333$mock" ".omx/artifacts/visual-ralph/all-pages-final/${vp_id}-mock-${id}.png" >/dev/null
  done
  echo "captured $id"
done < /tmp/aurora-route-map.tsv
python - <<'PY'
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
base=Path('.omx/artifacts/visual-ralph/all-pages-final')
routes=[line.strip().split('\t')[0] for line in Path('/tmp/aurora-route-map.tsv').read_text().splitlines() if line.strip()]
font=ImageFont.load_default()
def make(vp, scale_w, split_name, route_subset):
    thumbs=[]
    for r in route_subset:
        row=[]
        for kind in ['mock','prod']:
            img=Image.open(base/f'{vp}-{kind}-{r}.png').convert('RGB')
            ratio=scale_w/img.width
            img=img.resize((scale_w, int(img.height*ratio)))
            row.append(img)
        thumbs.append((r,row))
    label_h=18; pad=8; gap=8
    row_h=max(max(img.height for img in row) for _,row in thumbs)+label_h+pad
    w=scale_w*2+gap+pad*2
    h=row_h*len(thumbs)+pad
    sheet=Image.new('RGB',(w,h),(8,10,12))
    d=ImageDraw.Draw(sheet)
    y=pad
    for r,row in thumbs:
        d.text((pad,y),f'{r}: mock | prod', fill=(220,235,240), font=font)
        y2=y+label_h
        sheet.paste(row[0],(pad,y2)); sheet.paste(row[1],(pad+scale_w+gap,y2))
        y += row_h
    out=base/f'contact-{vp}-{split_name}.jpg'
    sheet.save(out, quality=88)
    print(out)
make('desktop', 360, 'a', routes[:11])
make('desktop', 360, 'b', routes[11:])
make('mobile', 195, 'a', routes[:11])
make('mobile', 195, 'b', routes[11:])
PY
```

## Required verification after refinements

Run the smallest relevant tests first, then at least:

```sh
pnpm --filter @aurora/ui test -- --reporter=dot
pnpm --filter @aurora/ui typecheck
pnpm --filter @aurora/tauri-ui typecheck
pnpm --filter @aurora/tauri-ui test -- src/aurora-client.test.tsx --reporter=dot
git diff --check
```

If styling changes affect responsive snapshots, update `packages/aurora-ui/tests/accessibility-responsive-visual.test.tsx` only after manually reviewing desktop/tablet/mobile evidence.

## Suggested prompt for the next agent

```text
Use docs/TAURI_UI_VISUAL_REFINEMENT_HANDOFF.md as the controlling visual handoff.
Use modules/ui-mock-reference as the source of truth and .omx/artifacts/visual-ralph/all-pages-final as current mock-vs-production evidence.
Refine every Aurora production UI route toward the dark dense mock cockpit while preserving real SDK/Gateway/platform truth.
Do not introduce placeholder/debug/task/evidence UI.
Work route-by-route, capture desktop/mobile screenshots after each meaningful pass, and run the UI/Tauri tests listed in the handoff.
Prioritize: Backups, Data Policy, Native Settings, Tools, Config, Mesh, Scheduler, and Audit, then make shared token/CSS cleanup once visual parity is stable.
```

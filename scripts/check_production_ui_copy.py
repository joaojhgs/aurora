#!/usr/bin/env python3
"""Check production UI string literals for forbidden implementation wording."""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from dataclasses import dataclass


DEFAULT_PATHS = (
    "packages/aurora-ui/src",
    "apps/aurora-web/app",
    "apps/aurora-tauri/src",
)

FORBIDDEN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("raw-render-expression", re.compile(r"\braw-render-expression\b", re.I)),
    ("proof", re.compile(r"\bproof\b", re.I)),
    ("evidence", re.compile(r"\bevidence\b", re.I)),
    ("fixture", re.compile(r"\bfixtures?\b", re.I)),
    ("assertion", re.compile(r"\bassertions?\b", re.I)),
    ("implementation", re.compile(r"\bimplement(?:ation|ed|ing)?\b", re.I)),
    ("tested", re.compile(r"\btested\b", re.I)),
    ("debug", re.compile(r"\bdebug(?:ging)?\b", re.I)),
    ("fallback", re.compile(r"\bfallback\b", re.I)),
    ("provider-consumer-role", re.compile(r"\b(?:provider|consumer|hybrid)\b", re.I)),
    ("route-counts", re.compile(r"\b\d+\s*/\s*\d+\s+routes?\b|\broute counts?\b", re.I)),
    ("manifest", re.compile(r"\bmanifest\b", re.I)),
    ("contract", re.compile(r"\bcontracts?\b", re.I)),
    ("protocol", re.compile(r"\bprotocol\b", re.I)),
    ("transport", re.compile(r"\btransport\b", re.I)),
    ("runtime", re.compile(r"\bruntime\b", re.I)),
    ("schema", re.compile(r"\bschema\b", re.I)),
    ("migration", re.compile(r"\bmigrations?\b", re.I)),
    ("sqlite", re.compile(r"\bsqlite\b", re.I)),
    ("indexeddb", re.compile(r"\bindexeddb\b", re.I)),
    ("opfs", re.compile(r"\bopfs\b", re.I)),
    ("sidecar", re.compile(r"\bsidecar\b", re.I)),
    ("thin", re.compile(r"\bthin\b", re.I)),
    ("http", re.compile(r"\bhttps?\b", re.I)),
    ("webrtc-wss", re.compile(r"\b(?:webrtc|wss?)\b", re.I)),
    ("signaling", re.compile(r"\bsignaling\b", re.I)),
    ("datachannel", re.compile(r"\bdatachannel\b", re.I)),
    ("room-password", re.compile(r"\broom password\b", re.I)),
    ("remote-console", re.compile(r"\bremote[- ]console\b", re.I)),
    ("mesh-node", re.compile(r"\bmesh[- ]node\b", re.I)),
    ("runtime-tier", re.compile(r"\bruntime[- ]tier\b", re.I)),
    ("key-path", re.compile(r"\bkey[-_ ]?paths?\b|\b(?:services|gateway|auth|config|orchestrator|tts|stt|db|tooling|scheduler)\.[a-z0-9_.]+\b", re.I)),
)

ATTRIBUTE_NAMES = {
    "aria-label",
    "title",
    "placeholder",
    "alt",
    "label",
    "description",
    "disabledReason",
}

INTERNAL_DATA_FIELD_NAMES = {
    "id",
    "kind",
    "mode",
    "nodeMode",
    "runtimeTier",
    "transportKind",
    "evidence",
    "evidenceSource",
    "source",
    "roomSecretRef",
    "localStablePeerId",
    "nodeName",
}

ADVANCED_CONNECTION_ALLOWLIST: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("packages/aurora-ui/src/product-copy.ts", "Aurora address", re.compile(r"\baddressLabel\s*:", re.S)),
    ("packages/aurora-ui/src/product-copy.ts", "Connection method", re.compile(r"\bmethodLabel\s*:", re.S)),
    ("packages/aurora-ui/src/web-thin-connection-panel.tsx", "HTTP only", re.compile(r"<SelectItem\b[^>]*\bvalue=\"http-only\"", re.S)),
    ("packages/aurora-ui/src/web-thin-connection-panel.tsx", "WebRTC only", re.compile(r"<SelectItem\b[^>]*\bvalue=\"webrtc-only\"", re.S)),
    ("packages/aurora-ui/src/web-thin-connection-panel.tsx", "WebRTC preferred", re.compile(r"<SelectItem\b[^>]*\bvalue=\"webrtc-preferred\"", re.S)),
    (
        "packages/aurora-ui/src/tooling/tooling-console.tsx",
        "stdio command or https://server",
        re.compile(r"\bServer URL or command profile\b[\s\S]{0,900}\bplaceholder=\{canLaunchLocalCommands \?", re.S),
    ),
    (
        "packages/aurora-ui/src/tooling/tooling-console.tsx",
        "https://server",
        re.compile(r"\bServer URL or command profile\b[\s\S]{0,900}\bplaceholder=\{canLaunchLocalCommands \?", re.S),
    ),
    (
        "packages/aurora-ui/src/components/assistant-ui/mcp-config.tsx",
        "https://example.com/mcp",
        re.compile(r"<McpAddFormPrimitive\.UrlField\b[\s\S]{0,220}\bplaceholder=", re.S),
    ),
)


@dataclass(frozen=True)
class Finding:
    path: pathlib.Path
    line: int
    term_id: str
    text: str


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Files or directories to scan.")
    parser.add_argument("--repo-root", default=".", help="Repository root. Defaults to cwd.")
    args = parser.parse_args(argv)

    repo_root = pathlib.Path(args.repo_root).resolve()
    paths = [repo_root / path for path in (args.paths or DEFAULT_PATHS)]
    findings: list[Finding] = []
    for path in expand_paths(paths):
        findings.extend(scan_file(path, repo_root))

    if findings:
        for finding in findings:
            rel = finding.path.relative_to(repo_root) if finding.path.is_relative_to(repo_root) else finding.path
            print(f"{rel}:{finding.line}: {finding.term_id}: {finding.text}", file=sys.stderr)
        print(f"Found {len(findings)} production UI copy issue(s).", file=sys.stderr)
        return 1
    return 0


def expand_paths(paths: list[pathlib.Path]) -> list[pathlib.Path]:
    expanded: list[pathlib.Path] = []
    for path in paths:
        if path.is_dir():
            expanded.extend(sorted(child for child in path.rglob("*") if is_scan_target(child)))
        elif path.exists():
            if is_scan_target(path):
                expanded.append(path)
    return expanded


def is_scan_target(path: pathlib.Path) -> bool:
    if path.suffix not in {".ts", ".tsx"}:
        return False
    if "tests" in path.parts or re.search(r"\.test\.[tj]sx?$", path.name):
        return False
    if path.name.endswith(".d.ts"):
        return False
    return True


def scan_file(path: pathlib.Path, repo_root: pathlib.Path) -> list[Finding]:
    text = path.read_text(encoding="utf-8")
    clean = strip_comments(text)
    findings: list[Finding] = []
    rel_path = repo_relative_path(path, repo_root)
    for line_no, literal, context in rendered_literals(clean, rel_path):
        stripped = normalize_literal(literal)
        if (
            not stripped
            or is_allowed_connection_copy(rel_path, stripped, context)
        ):
            continue
        for term_id, pattern in FORBIDDEN_PATTERNS:
            if pattern.search(stripped):
                findings.append(Finding(path, line_no, term_id, stripped))
    return findings


def repo_relative_path(path: pathlib.Path, repo_root: pathlib.Path) -> str:
    try:
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def strip_comments(text: str) -> str:
    out: list[str] = []
    index = 0
    quote: str | None = None
    escaped = False
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if quote:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if char in {"'", '"', "`"}:
            quote = char
            out.append(char)
            index += 1
            continue
        if char == "/" and nxt == "/":
            while index < len(text) and text[index] != "\n":
                out.append(" ")
                index += 1
            continue
        if char == "/" and nxt == "*":
            out.extend("  ")
            index += 2
            while index < len(text) - 1 and not (text[index] == "*" and text[index + 1] == "/"):
                out.append("\n" if text[index] == "\n" else " ")
                index += 1
            if index < len(text) - 1:
                out.extend("  ")
                index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def rendered_literals(text: str, rel_path: str) -> list[tuple[int, str, str]]:
    results: list[tuple[int, str, str]] = []
    line_starts = [0]
    for match in re.finditer(r"\n", text):
        line_starts.append(match.end())

    def line_for(index: int) -> int:
        low, high = 0, len(line_starts)
        while low + 1 < high:
            mid = (low + high) // 2
            if line_starts[mid] <= index:
                low = mid
            else:
                high = mid
        return low + 1

    attr_pattern = re.compile(rf"(?:{'|'.join(re.escape(name) for name in ATTRIBUTE_NAMES)})\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|\{{\s*(['\"])(.*?)\3\s*\}})", re.S)
    for match in attr_pattern.finditer(text):
        value = next((group for group in match.groups() if group and group not in {"'", '"'}), "")
        if value.strip():
            results.append((line_for(match.start()), value, literal_render_context(text, match.start(), match.end())))

    for line_no, line in enumerate(text.splitlines(), start=1):
        for match in re.finditer(r">([^<>{}]+)<", line):
            value = match.group(1)
            if re.search(r"=>|\?\?|\b\w+\.\w+\b|[\[\]=?]", value):
                continue
            if value.strip():
                results.append((line_no, value, line))

    for literal in string_literals(text):
        context = literal_context(text, literal.start)
        if is_rendered_literal_context(context, rel_path):
            results.append((line_for(literal.start), literal.value, literal_render_context(text, literal.start, literal.end)))

    results.extend(rendered_dynamic_expressions(text, line_for))

    return results


@dataclass(frozen=True)
class StringLiteral:
    start: int
    end: int
    value: str
    quote: str


def string_literals(text: str) -> list[StringLiteral]:
    literals: list[StringLiteral] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char not in {"'", '"', "`"}:
            index += 1
            continue
        quote = char
        start = index
        index += 1
        escaped = False
        value: list[str] = []
        while index < len(text):
            char = text[index]
            if escaped:
                value.append(char)
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                index += 1
                break
            else:
                value.append(char)
            index += 1
        literals.append(StringLiteral(start=start, end=index, value="".join(value), quote=quote))
    return literals


def literal_context(text: str, start: int, width: int = 480) -> str:
    return text[max(0, start - width):start]


def is_rendered_literal_context(context: str, rel_path: str) -> bool:
    stripped = context.rstrip()
    if is_internal_data_literal_context(stripped):
        return False
    copy_field = r"(?:label|title|description|detail|reason|repair|error|message|evidence|summary|empty|action|placeholder|aria-label|disabledReason)"
    if re.search(r"\b(?:setMessage|setError|set[A-Za-z]+Error|set[A-Za-z]+Message|toast|alert)\s*\([^)]*$", stripped):
        return True
    if re.search(rf"\b{copy_field}\s*:\s*$", stripped):
        nearby = stripped[-240:]
        return bool(re.search(r"\b(?:return|render|visible|copy|message|status|diagnostic|alert|toast|view|panel|card|dialog|empty)\b", nearby, re.I))
    if rel_path.endswith(".tsx") and re.search(r"\breturn\s*$", stripped):
        nearby = stripped[-320:]
        return bool(re.search(r"\b(?:copy|message|status|diagnostic|alert|toast|view|panel|card|dialog|label|title|description|detail|reason|repair|error|evidence)\b", nearby, re.I))
    current_line = stripped.splitlines()[-1] if stripped else ""
    if (current_line.endswith("?") and not current_line.endswith("??")) or re.search(r"\?[^{};]*:\s*$", current_line):
        nearby = stripped[-160:]
        return bool(
            (rel_path.endswith(".tsx") and re.search(r"\breturn\b", nearby))
            or re.search(rf"\b{copy_field}\b", nearby)
            or re.search(r"\b(?:copy|message|status|diagnostic|alert|toast|view|panel|card|dialog)\b", nearby, re.I)
            or re.search(r"\b[A-Za-z]*(?:Label|Title|Description|Detail|Reason|Repair|Error|Message|Evidence|Copy)\b", nearby)
        )
    return False


def is_internal_data_literal_context(context: str) -> bool:
    current_line = context.splitlines()[-1] if context else ""
    field_names = "|".join(re.escape(name) for name in INTERNAL_DATA_FIELD_NAMES)
    if re.search(rf"\b(?:{field_names})\s*:\s*$", current_line):
        return True
    if re.search(rf"\b(?:{field_names})\s*:\s*[^,;{{}}]*[?:]\s*$", current_line):
        return True
    nearby = context[-420:]
    if re.search(r"\blabel\s*:\s*$", current_line) and re.search(
        r"\b(?:ThinConnectionProfile|RuntimeProfile|thinSurfaceDefaults|defaultProfileForSurface|sanitizeThinConnectionProfile|currentAuroraSurfaceProfile|surface\.isAndroid|surface\.isIos|productionSurfaceContracts|ProductionSurfaceContract|mockUxAnchors|routeOracle)\b",
        nearby,
    ):
        return True
    if re.search(r"\blabel\s*:\s*$", current_line) and re.search(
        r"\bid\s*:\s*['\"][a-z0-9-]+['\"],\s*\n\s*label\s*:\s*$",
        nearby,
        re.I,
    ):
        return True
    return False


def rendered_dynamic_expressions(text: str, line_for) -> list[tuple[int, str, str]]:
    results: list[tuple[int, str, str]] = []
    jsx_sink_patterns = (
        re.compile(r"<(?:AlertTitle|AlertDescription)\b[^>]*>\s*\{([^{}]+)\}", re.S),
        re.compile(r"<[^>]*\brole\s*=\s*(?:\"alert\"|'alert')[^>]*>\s*\{([^{}]+)\}", re.S),
        re.compile(r"\b(?:title|disabledReason|aria-label|label|description)\s*=\s*\{([^{}]+)\}", re.S),
    )
    call_sink_pattern = re.compile(
        r"\b(?:setMessage|setError|set[A-Za-z]+Error|set[A-Za-z]+Message|toast|alert)\s*\(([^;\n]+)\)",
        re.S,
    )
    for pattern in jsx_sink_patterns:
        for match in pattern.finditer(text):
            expression = normalize_expression(match.group(1))
            if is_suspicious_render_expression(expression):
                results.append((line_for(match.start(1)), f"raw-render-expression {expression}", literal_render_context(text, match.start(1), match.end(1))))
    for match in call_sink_pattern.finditer(text):
        expression = normalize_expression(match.group(1))
        if is_suspicious_render_expression(expression):
            results.append((line_for(match.start(1)), f"raw-render-expression {expression}", literal_render_context(text, match.start(1), match.end(1))))
    return results


def normalize_expression(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def is_suspicious_render_expression(expression: str) -> bool:
    if not expression:
        return False
    if re.search(
        r"\b(?:safeErrorCopy|productStatusCopy|uiErrorMessage|productDiagnosticMessage|onboardingErrorMessage|meshPeerErrorMessage|meshSafeErrorTitle|serviceRoutingSafeError|presentableSignal|permissionLabel|permissionSummary|product[A-Za-z]+Copy)\b",
        expression,
    ):
        return False
    return bool(
        re.search(r"\.message\b", expression)
        or re.search(r"\b(?:error|diagnostic|diagnostics|disabledReason|methodId|method_id|busTopic|topic|keyPath|key_path)\b", expression)
        or re.search(r"\b[A-Z][A-Za-z0-9]*_METHODS\b|\b[A-Z][A-Za-z0-9]*Methods\b", expression)
    )


def normalize_literal(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def literal_render_context(text: str, start: int, end: int, width: int = 900) -> str:
    return text[max(0, start - width):min(len(text), end + width)]


def is_allowed_connection_copy(path: str, value: str, context: str) -> bool:
    return any(
        path == allowed_path
        and value == allowed_value
        and context_pattern.search(context)
        for allowed_path, allowed_value, context_pattern in ADVANCED_CONNECTION_ALLOWLIST
    )




if __name__ == "__main__":
    raise SystemExit(main())

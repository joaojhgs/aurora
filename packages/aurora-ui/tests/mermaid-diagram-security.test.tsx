// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { sanitizeMermaidSvg } from '../src/components/assistant-ui/mermaid-diagram'

describe('MermaidDiagram SVG sanitizer', () => {
  it('keeps local Mermaid SVG shapes and references', () => {
    const sanitized = sanitizeMermaidSvg(
      '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><g class="node"><rect id="box" width="10" height="10" fill="var(--background)" stroke="url(#arrow)"/><text x="1" y="1">Aurora</text></g></svg>',
    )

    expect(sanitized).toContain('<svg')
    expect(sanitized).toContain('marker')
    expect(sanitized).toContain('url(#arrow)')
    expect(sanitized).toContain('Aurora')
  })

  it('fails closed on executable SVG nodes', () => {
    expect(sanitizeMermaidSvg('<svg><script>alert(1)</script><rect width="1" height="1"/></svg>')).toBeNull()
    expect(sanitizeMermaidSvg('<svg><foreignObject><div>unsafe</div></foreignObject></svg>')).toBeNull()
  })

  it('removes executable attributes and unsafe references', () => {
    const sanitized = sanitizeMermaidSvg(
      '<svg onload="alert(1)"><style>.x{fill:red}</style><rect width="1" height="1" onclick="alert(1)" fill="javascript:alert(1)" href="https://example.invalid"/><text style="fill: red">Safe</text></svg>',
    )

    expect(sanitized).toContain('Safe')
    expect(sanitized).not.toMatch(/onload|onclick|javascript:|example\.invalid/iu)
  })

  it.each([
    ['flowchart', 'flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Go]\n  B -->|no| D[Wait]', ['Start', 'Ready?', 'Go', 'Wait']],
    ['sequence', 'sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: Hello\n  B-->>A: Hi', ['Alice', 'Bob', 'Hello', 'Hi']],
    ['class', 'classDiagram\n  class Animal {\n    +String name\n    +move()\n  }\n  Animal <|-- Dog', ['Animal', 'Dog', 'name', 'move']],
    ['state', 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start\n  Running --> Idle: stop', ['Idle', 'Running', 'start', 'stop']],
    ['er', 'erDiagram\n  USER ||--o{ ORDER : places\n  USER {\n    string id\n    string name\n  }\n  ORDER {\n    string id\n  }', ['USER', 'ORDER', 'places', 'name']],
  ])('preserves generated %s diagram semantics', (_name, source, labels) => {
    const raw = renderMermaidSVG(source, {
      bg: 'var(--background)',
      fg: 'var(--foreground)',
      muted: 'var(--muted-foreground)',
      border: 'var(--border)',
      accent: 'var(--foreground)',
      transparent: true,
    })
    const sanitized = sanitizeMermaidSvg(raw)

    expect(sanitized).not.toBeNull()
    if (raw.includes('marker-start')) expect(sanitized).toContain('marker-start')
    if (raw.includes(' dy=')) expect(sanitized).toContain(' dy=')
    for (const label of labels) {
      expect(sanitized).toContain(label)
    }
    expect(sanitized).not.toMatch(/<script|foreignObject|javascript:|vbscript:|expression\s*\(/iu)
  })
})

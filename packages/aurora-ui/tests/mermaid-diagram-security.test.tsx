// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
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
})

## Aurora cockpit design system — conventions

This library is a set of compiled, ready-to-import React components. There is
no React context provider to wrap your app in — none of these components read
from a shared provider or theme context.

### Always wrap your top-level container in the theme surface

The design language is **dark by default** (`color-scheme: dark`), driven
entirely by CSS custom properties on `:root` — no provider needed for that
part. But several components (plain text, `Table`, form controls) render
their text using `var(--foreground)`, a near-white color meant to sit on the
dark `var(--background)`. They do **not** each carry their own background —
they expect the *page* to already be dark. Always give the outermost
container of anything you build with this library:

```tsx
<div className="bg-background text-foreground">{/* your composition */}</div>
```

Without this wrapper, components that don't provide their own surface
(bare text, `Table` rows, form inputs) will render illegibly (near-white
text with no dark backdrop under it). Components that already set their own
surface — `Card` (`bg-card`), `Button`'s non-ghost variants, `Badge`,
`Dialog`'s popup (`bg-popover`) — look correct regardless, but wrap anyway
for a consistent page background.

### Styling idiom: semantic Tailwind utility tokens

Style with Tailwind utility classes built on semantic color tokens — never
raw colors. Real tokens available (each has a matching `-foreground` pair
for text placed on that surface):

| Surface token | Use for |
|---|---|
| `background` / `foreground` | page background / default text |
| `card` / `card-foreground` | `Card` and card-like surfaces |
| `popover` / `popover-foreground` | `Dialog`, `Sheet`, `DropdownMenu` surfaces |
| `primary` / `primary-foreground` | primary actions (default `Button` variant) |
| `secondary` / `secondary-foreground` | secondary actions and badges |
| `muted` / `muted-foreground` | de-emphasized text, subtle backgrounds |
| `accent` / `accent-foreground` | hover/active highlight states |
| `destructive` / `destructive-foreground` | dangerous actions, error badges |
| `success` / `success-foreground`, `warning` / `warning-foreground`, `info` / `info-foreground` | status badges and alerts |
| `border`, `input`, `ring` | borders, form field outlines, focus rings |
| `chart-1` … `chart-5` | data visualization series |
| `sidebar`, `sidebar-foreground`, `sidebar-accent`, etc. | navigation-rail surfaces |

Use them as `bg-<token>`, `text-<token>`, `border-<token>`, `ring-<token>`.
Radius follows a fixed scale: `rounded-{sm,md,lg,xl,2xl,3xl,4xl}` (backed by
`--radius-*`, derived from a single `--radius` base) — don't use arbitrary
`rounded-[Npx]` values.

### Where the truth lives

Read `styles.css` (imports the full compiled `_ds_bundle.css` token/utility
set) before styling anything — it's the authoritative list of what's
available. Each component's `.prompt.md` documents its own props and
composition examples.

### Idiomatic example

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button, Badge } from '<pkg>'

function Example() {
  return (
    <div className="bg-background text-foreground p-6">
      <Card className="w-80">
        <CardHeader>
          <CardTitle>Mesh peer trust</CardTitle>
          <CardDescription>3 peers awaiting approval</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Review each peer's identity fingerprint before granting access.
          </p>
        </CardContent>
        <CardFooter>
          <Button variant="outline" size="sm">Dismiss</Button>
          <Button size="sm">Review queue</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
```

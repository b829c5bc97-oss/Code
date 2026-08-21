# Store — a concept homepage

A single self-contained HTML file (`store/index.html`, ~1,400 lines, no build
step, no dependencies, no network requests) that behaves like a real product
storefront rather than a static mockup.

Open it directly in a browser. It works offline.

## What actually works

**Search** — press `/` or `⌘K` anywhere. Ranked matching (exact prefix > word
start > substring > tight subsequence on names only), category chips, arrow-key
navigation with `aria-selected`, Enter opens the result and scrolls to it,
Escape closes. Products and help topics are indexed together.

**Bag** — add from any card, tile, comparison row or the configurator.
Duplicate items increment instead of stacking, quantity steppers remove at zero,
and the subtotal, 8.25% tax, delivery and total recompute on every change. The
whole bag persists in `localStorage`, so it survives a reload. Free-delivery
progress bar included.

**Configurator** — finish, size, storage and AppleCare+. Every choice repaints
the SVG render (the finish drives a CSS custom property), updates the price, the
24-month instalment, the spec line and the delivery estimate. Adding to the bag
carries the full configuration as a distinct line item, so two differently-specced
phones don't merge.

**Comparison** — three dropdowns build the table live. The strongest value in each
row is marked automatically, but only within a single product category: comparing
a phone against a laptop marks price alone, because a lighter phone is not a
better laptop.

**Trade-in** — selecting a device applies credit to the bag total and adds a
credit row to the summary.

**Everything else** — mega-menu nav with `aria-expanded`, mobile drawer,
drag/scroll/arrow carousel with disabled-state buttons, focus trapping and focus
restore on both overlays, Escape closing whatever is topmost, footer accordions
on small screens, scroll reveals, dark mode following the system and remembering
an override, and full `prefers-reduced-motion` support.

## Verification

`store.mjs` (in the working scratchpad, not committed) drives the page in
headless Chromium: 50 assertions covering search ranking and filtering, cart
arithmetic and persistence, configurator pricing, comparison logic, carousel
state, mobile layout and console cleanliness. All 50 pass on three consecutive
runs, with no horizontal overflow at 390px and no console errors.

## Note

An independent front-end concept for demonstration. Not affiliated with,
endorsed by, or connected to Apple Inc. Product names, prices, specifications
and delivery estimates are invented, and nothing is offered for sale.

# Apple Software Beta — concept page

A single self-contained HTML file (`beta/index.html`) presenting a fictional
"iOS 27 Developer Beta" release page in the style of an OS launch site.

Open `beta/index.html` directly in a browser — no build step, no dependencies,
no network requests.

## What works

- **Light / dark theme toggle** — respects `prefers-color-scheme` on first load
  and remembers the choice in `localStorage`.
- **Platform tabs** — iOS / iPadOS / macOS / watchOS / visionOS, keyboard
  navigable with arrow keys, proper `role="tab"` / `aria-selected` wiring.
- **Device mockups** with a live clock and date.
- **Compatibility checker** — device menu repopulates from the chosen platform
  and returns a supported / limited / unsupported verdict with download size
  and minimum requirements.
- **Release notes** — filterable by New / Resolved / Known issues, rendered from
  a data array into `<details>` accordions.
- **Copy buttons** on the install commands, with an `execCommand` fallback.
- **Email form** with validation and inline success/error messaging (demo only —
  nothing is submitted anywhere).
- Scroll progress bar, scroll-reveal animations, animated stat counters,
  back-to-top button, sticky nav with mobile menu.
- Responsive down to 390px with no horizontal overflow, and honours
  `prefers-reduced-motion`.

## Note

This is an independent design concept for demonstration purposes. It is not
affiliated with or endorsed by Apple Inc. Every version number, feature, date
and build string on the page is invented, and no software is distributed.

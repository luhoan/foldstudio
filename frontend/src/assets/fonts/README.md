# Bundled typefaces

The app ships its own fonts so it looks the same on every machine and works with no network
(the backend and the cluster are often used offline). Only the Latin subsets are included.

| File | Typeface | Used for | Source package | Licence |
|---|---|---|---|---|
| `stix-two-text-latin-wght-normal.woff2` | STIX Two Text (variable, 400–700) | page titles, wordmark | `@fontsource-variable/stix-two-text` 5.3.0 | SIL OFL 1.1 — `LICENSE-STIX-Two-Text.txt` |
| `ibm-plex-sans-latin-wght-normal.woff2` | IBM Plex Sans (variable, 100–700) | interface text | `@fontsource-variable/ibm-plex-sans` 5.3.0 | SIL OFL 1.1 — `LICENSE-IBM-Plex-Sans.txt` |
| `ibm-plex-mono-latin-400-normal.woff2`, `…-500-…` | IBM Plex Mono | sequences, ids, paths | `@fontsource/ibm-plex-mono` 5.3.0 | SIL OFL 1.1 — `LICENSE-IBM-Plex-Mono.txt` |

The files are byte-for-byte copies from those npm packages; nothing was modified or renamed
beyond dropping them here. They are declared in `src/layout/typography.css`. Characters outside the
Latin subset (≥, Greek letters) fall back to the system font.

To remove them: delete this directory, `src/layout/typography.css` and the `@import` of it at the
top of `theme.css`. Every font-family in the theme names its own system fallback.

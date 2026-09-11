# Receipts

A shared receipt book for FnM — one self-contained HTML file, backed by Supabase.

Live: https://heartfelt-haupia-bb3c9b.netlify.app

## How it works

`index.html` at the repo root is the whole app: no build step, no dependencies to
install, no framework. Netlify publishes the root directory as-is, so a push to
`main` is a deploy.

It is generated, though — don't hand-edit it.

## Making a change

    cd src
    python3 build.py        # writes ../index.html from template.html
    node ui-test.js         # 133 checks, all must pass

- `src/template.html` — the real source. Placeholders (`__SB_URL__`, `__ICON180__`
  and so on) are filled in by the build.
- `src/build.py` — substitutes the Supabase URL, the publishable key and the
  base64 icons, then writes `index.html`.
- `src/ui-test.js` — Playwright suite covering auth, the calendar, capture, the
  scan processor, OCR parsing, VAT, storage clearing and the PDF export.
  Third-party libraries are stubbed where the sandbox cannot reach their CDN.
- `src/mock-supabase.js` — a stand-in Supabase client the tests run against.
- `src/scan-quality.js` — renders a synthetic receipt photo and its scanned
  version, for eyeballing the image processing after changes.

## Notes

The Supabase key in `index.html` is the *publishable* key. It is designed to sit
in browser code; row-level security is what actually protects the data. The
secret key is not in this repo and must never be.

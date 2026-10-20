# Infinity PDF

A standalone Arabic RTL web app for converting **public** webpages into selectable-text PDF files. It was inspired by the general workflow of Just-One-Page-PDF, but uses an independent interface and implementation.

## Current features

- Render one public webpage to one long PDF page, or export it to standard pages.
- Paper choices: A4, A3, Letter, and Legal, with portrait/landscape options.
- Screen rendering or the page's print CSS, backgrounds, margins, headers and footers.
- Best-effort clean mode for common ad, cookie, modal and sticky elements.
- Sequential processing for up to five public URLs per batch.
- Arabic right-to-left interface, responsive layout, input validation, progress feedback, and explicit error messages.
- PDF generation via headless Chromium; page text generally remains selectable/searchable rather than being flattened into a screenshot.

## Important limits

- This is a **website**, not a browser extension. It cannot use cookies from the visitor's browser, reach authenticated/private pages, or provide the extension's exact click-and-drag region selection and multi-tab access.
- The URL is processed by a server-side Chromium function. Do not submit private links or links containing secret tokens. The app does not intentionally persist generated PDFs, but your hosting provider may keep operational logs.
- Single-page PDFs are limited by Chromium's practical page dimensions; choose standard paged output for very tall pages.
- Clean mode is heuristic. It may hide elements that a particular website needs.
- A server-side browser that accepts arbitrary public URLs has outbound-network security considerations. The function rejects private and reserved IP targets on navigations and subresources, but high-volume production use should add a network-level egress firewall and a shared rate limiter.

## Deploy on Vercel

1. Import aamrabdelhay/infinitycorp as a Vercel project (or connect this repository to an existing Vercel project).
2. Set **Root Directory** to **infinity-pdf**.
3. Use Node.js **24.x**, which matches the Chromium package selected for this project.
4. Deploy the feature/infinity-pdf branch as a Preview first and test it with public, non-sensitive URLs. Do not point the production domain at it until runtime rendering has been validated.

No database, sign-in, external PDF storage, or paid third-party PDF API is required. The Chromium dependency is sizeable, so the deployment must be tested against your Vercel plan's function bundle, memory and execution limits.

## Local checks

Run **npm install** and then **npm run check** from this directory. The check validates JavaScript syntax; it does not replace an end-to-end PDF render test inside the deployed serverless Chromium environment.

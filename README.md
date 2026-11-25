# Quire

Quire is a private invoice studio. You compose an invoice, watch it set itself as a printed sheet, and save a PDF from the browser’s print dialog. It is a static site: one `index.html` at the repository root, plus CSS, scripts, and graphics. GitHub Pages serves it as-is. There is no build step, no account, and no backend.

Invoice details, logos, and drafts stay in this browser. The page does not send them anywhere.

## Assumptions

- One person, one browser. There are no accounts and no shared inbox.
- Money is display-only. Choosing euros does not convert dollars; the numbers you type are already in that currency.
- One discount (a percent or a fixed amount) comes off the subtotal. One tax rate applies to what remains. This is not a multi-jurisdiction tax engine.
- Quantities and rates use a decimal point (`1.5`, `75.00`). Commas are treated as thousands separators.
- Built-in currencies use 0 or 2 decimal places. “Other symbol” is the same choice. A 3-decimal currency is a later addition.
- Invoice numbers live in this browser. Starting a new invoice shows the next number, and the counter advances when that invoice is kept or you assign the next number. Gaps are normal if a draft is discarded.
- “Print / PDF” opens the browser dialog. Quire does not generate a PDF file itself.
- A draft holds up to 40 lines. This browser keeps up to 30 drafts.
- SVG uploads are refused. A logo must be a PNG, JPEG, WebP, or GIF, and it is resized on the device before it is stored.

## Features

- From and bill-to, with addresses, contact, and an optional tax ID
- Issue date, due date, PO number, and a local invoice number
- Line items with quantity, rate, and a computed amount
- Percent or fixed discount, then a named tax rate
- Currency list, plus a custom symbol
- Three templates: Ledger, Seal, and Plain
- A4 or US Letter page size for print
- Logo upload, kept with the draft
- Autosave to `localStorage`, a draft library, duplicate, and delete
- A sample invoice (Northwind Atelier) so the sheet is never a blank first impression
- Download and restore a JSON backup, still on this device
- A print layout that omits the editor. The browser tab title is the invoice number and client, which many browsers offer as the PDF filename

## Visual system

The system is called Pressmark. The screen is a typesetter’s desk; the invoice is the only sheet of paper on it. Vermilion is a second ink, used the way a printer uses a spot color: the seal, the primary button, and one rule. Corners are cut at 2px rather than rounded into a generic app card.

### Color

| Role | Hex | Use |
| --- | --- | --- |
| Desk | `#E6DFD2` | Page background |
| Editor | `#F6F1E7` | Form panel and dialogs |
| Sheet | `#FFFCF8` | The invoice paper and fields |
| Ink | `#1C1916` | Text, rules, selected controls |
| Ink soft | `#3F3830` | Secondary text |
| Ink muted | `#5C5348` | Labels and hints |
| Rule | `#D5CBBC` | Hairlines and panel borders |
| Field line | `#CDBFAE` | Input borders |
| Seal | `#6E2218` | Primary buttons and the wax seal |
| Seal deep | `#541910` | Button hover |
| Vermilion | `#C4452F` | The single accent rule and the sample notice |
| Moss | `#1E5C3A` | Saved confirmation, on `#E7F3EC` |
| Fault | `#8E1E1E` | Errors, on `#F8E8E4` |
| Warn | `#6F4A10` | Cautions, on `#F8F0DE` |

Ink on the sheet is about 17:1. Muted labels on the editor are about 6.7:1. Cream on the seal button is about 10.8:1. The desk stays light on purpose: the PDF is paper, and a dark chrome would lie about the printed sheet.

### Type

- **Instrument Serif** for the wordmark, invoice titles, client names, and the Ledger total. Italic is reserved for the Seal template’s title and the closing line.
- **Instrument Sans** for the tools and the Plain template. Weights 400, 500, and 600.
- Both are the SIL Open Font License subsets in `assets/fonts/`, so the page does not call a font host. Licenses are in that folder.
- Fallbacks are Palatino / Georgia and Avenir Next / Segoe UI.
- Amounts use tabular figures.

### Space, icons, motion

Spacing steps are 4, 8, 12, 16, 22, 28, and 40. The mark is an original folded sheet with a seal, drawn as SVG in `assets/brand/`. Icons are a small stroke set in the page, 1.75px, round caps, on a 24 grid.

Motion is a short wash when a line is added, a soft rise on a confirmation, and a loading sheen before the sheet is ready. `prefers-reduced-motion: reduce` removes all of it. Focus is a 2px ink outline, not color alone.

### Templates

- **Ledger.** Serif name, a vermilion rule under “Invoice”, hairline table, double rule on the total.
- **Seal.** Ink header, italic title, vermilion seal with the number, totals set in an ink block. In the print dialog, turn on background graphics or that header prints blank.
- **Plain.** Sans throughout, wide spacing, a single ink rule on the left edge.

## Run it

No install. From the repository root:

```bash
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/`. Opening `index.html` directly also works: the scripts are classic files, not modules. GitHub Pages deploys the same tree from `main` with `.github/workflows/static.yml`. Relative paths matter, because the project site is served from a subpath.

Checks that do not need a browser:

```bash
node tests/pure.test.js
node tests/page.test.js
```

## Privacy and security

- Drafts are one JSON value, `quire.v1`, in `localStorage`.
- A backup file is a download you choose. Restoring one replaces the drafts on this device.
- Text is written with `textContent`. A logo has to be a `data:image/(png|jpeg|webp|gif)` URL under 380 KB after resizing.
- The page sets a Content Security Policy that allows scripts, styles, and fonts only from itself, images only from itself or `data:`, and no network connections.
- Nothing in the scripts calls `fetch` or sends the invoice anywhere.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The studio |
| `assets/css/quire.css` | Pressmark, including print |
| `assets/js/pure.js` | Money, dates, numbering, and the storage shape |
| `assets/js/app.js` | The page |
| `assets/brand/` | Mark and favicon |
| `assets/fonts/` | Instrument Serif and Sans, plus their licenses |
| `tests/` | Node checks for the math and the page |

## What was exercised

Node checks cover line math (including `0.1 × 0.2` and half-up rounding), discount before tax, caps, negative and invalid numbers, yen with no decimals, invoice numbers, calendar dates, and rejection of SVG logos and unexpected backup shapes.

Headless Chrome then loaded the page and checked the Northwind sample total (`$1,312.20`), all three templates, a blocked print when a quantity is negative, text that stays text when it contains a tag, an added line (`$1,409.40`), the 100% discount cap, the due-date warning, yen formatting, reload from `localStorage`, a fresh `INV-001`, a PNG logo on the sheet, a refused SVG, the drafts dialog, and a JSON restore (`€20.00`). Print to PDF produced one A4 page and one US Letter page with the invoice totals and without the editor. The page made no requests off the local server and reported no console exceptions. Desktop (1440) and a 390px-wide phone were both screenshotted.

Not exercised here: a person’s print dialog on macOS or Windows (including the background-graphics checkbox), Safari, Firefox, a real screen reader, a full 40-line invoice across multiple printed pages, private-browsing storage, or the storage-full path. The Pages workflow file was not changed.

## Next

- Credit notes and partial payments
- Number entry that follows the local decimal comma
- More than one tax rate, and 3-decimal currencies
- A running header on long printed invoices, checked with a full page of lines
- Units on a quantity (hours, pieces)
- Merging a backup instead of replacing every draft
- A pass with VoiceOver or NVDA, and in Safari

# Phase 8 — Translation + Internationalization

Phase 8 separates structural interface translation from user-entered financial text.

## Structural UI

English is the source language. Reviewed English/French/Arabic interface copy lives in `client/src/locales.ts` and is applied synchronously. Language changes never wait for a network request, reload the page, or download a translation model before navigation is usable.

## Dynamic financial text

Comments, notes, reminders, transaction purposes and other uncatalogued text may be translated after the UI is interactive. The client prefers the browser Translator API when available and keeps a persistent device cache. The optional server fallback uses Google Cloud Translation only when `GOOGLE_TRANSLATE_API_KEY` is configured and maintains a durable PostgreSQL cache. Translation is still usable without a paid provider when the browser's local Translator API is available.

The original database text is never replaced by a translated display value. Account, business, project and person names plus codes, amounts, dates, percentages, emails, URLs and filenames are masked before machine translation and restored exactly afterwards.

## Prompts

French and Arabic prompts are normalized to English before the deterministic financial parser runs. The original prompt is restored into the saved `raw` field. The same normalization is used online and, when the local browser language pack is available, offline.

## RTL

Arabic sets `dir=rtl` at the document root. Financial numbers, numeric/date inputs and explicitly LTR values stay isolated LTR. Directional chevrons mirror for RTL.

## Persistence

The selected language is written locally immediately and saved to the signed-in user's server preference asynchronously. Login adopts the saved server preference in-place through an event; it does not reload the application.

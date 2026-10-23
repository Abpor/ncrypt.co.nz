# nCrypt homepage conversion tracking

GA4 measurement ID `G-ZC6K0BLN8K`. `assets/site.js` (homepage only) sends the events below.
Each carries first-touch `utm_*` (kept in `sessionStorage`), `landing_path` and `page_path`.

| Event | Fires when | Enquiry? |
|---|---|---|
| `audit_cta_clicked`, then `cta_click` | click on a `data-track` audit CTA (nav, hero, audit box). `cta_click` adds `label`, `destination` | No |
| `mailto_click` | click on any `mailto:` link | No (intent) |
| `generate_lead` | TidyCal embed posts `bookingComplete` (origin `https://tidycal.com`, source = the embed iframe, `data.booking.id` present). Once per booking id per session. Params: `method=tidycal_embed`, `booking_id`, `booking_type_id` | **Yes** |
| `booking_load_failed` | no TidyCal iframe after 8 s; email fallback is shown | No |

## Owner actions (unverified from the repo)

1. In GA4 Admin, mark `generate_lead` as a key event.
2. Make one real test booking on a throwaway slot, then confirm `generate_lead` in GA4 DebugView and cancel the booking.
   The `bookingComplete` shape comes from TidyCal's embed documentation; it has not been observed from the real service here.
3. Register `utm_source`, `utm_medium`, `utm_campaign`, `label`, `destination` as custom dimensions if needed.
4. Other pages (`/tools/`, `/policyproof/`, `/lithotraq/`) have no GA4 tag, so their clicks are not measured by this release.
5. Tracer: `init_tracer()` is defined on the homepage but nothing calls it, as before. This release only makes it safe.

No completion is inferred from clicks, the booking section being viewed, or the iframe loading.

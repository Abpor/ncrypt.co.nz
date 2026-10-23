// nCrypt homepage analytics wiring.
// Optional analytics must never prevent a visitor from booking or emailing us.
(function () {
  var ATTRIBUTION_KEY = "ncrypt_attribution";
  var BOOKED_KEY = "ncrypt_booked_ids";
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  var TIDYCAL_ORIGIN = "https://tidycal.com";

  function getAttribution() {
    try {
      var stored = window.sessionStorage.getItem(ATTRIBUTION_KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) {
      /* Storage may be blocked or hold bad JSON; carry on without it. */
    }
    var attribution = { landing_path: window.location.pathname };
    try {
      var params = new URLSearchParams(window.location.search);
      UTM_KEYS.forEach(function (key) {
        var value = params.get(key);
        if (value) attribution[key] = value;
      });
    } catch (e) {
      /* Keep the landing path only. */
    }
    try {
      window.sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(attribution));
    } catch (e) {
      /* Continue with the in-memory value. */
    }
    return attribution;
  }

  var attribution = getAttribution();

  function track(name, params) {
    try {
      if (typeof window.gtag === "function") {
        window.gtag("event", name, Object.assign({}, attribution, params || {}, { page_path: window.location.pathname }));
      }
    } catch (e) {
      /* analytics must never block the page */
    }
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-track]");
    if (el) {
      track(el.getAttribute("data-track"), { link_url: el.href || "" });
      track("cta_click", { label: (el.textContent || "").trim(), destination: el.getAttribute("href") || "" });
    }
    var mail = e.target.closest('a[href^="mailto:"]');
    if (mail) {
      track("mailto_click", { label: (mail.textContent || "").trim(), destination: mail.getAttribute("href") || "" });
    }
  });

  // TidyCal posts bookingComplete from its own origin when a booking is submitted
  // inside the embed. Accept it only from the embed's iframe with a well-formed payload.
  var tidycal = document.querySelector(".tidycal-embed");
  window.addEventListener("message", function (e) {
    try {
      if (e.origin !== TIDYCAL_ORIGIN) return;
      var data = e.data;
      if (!data || typeof data !== "object" || data.event !== "bookingComplete") return;
      var frame = tidycal && tidycal.querySelector("iframe");
      if (!frame || e.source !== frame.contentWindow) return;
      var booking = data.data && data.data.booking;
      if (!booking || typeof booking !== "object") return;
      var id = booking.id;
      if ((typeof id !== "number" && typeof id !== "string") || id === "") return;
      id = String(id);

      var seen = [];
      try { seen = JSON.parse(window.sessionStorage.getItem(BOOKED_KEY) || "[]"); } catch (err) { /* count it */ }
      if (seen.indexOf(id) !== -1) return;
      seen.push(id);
      try { window.sessionStorage.setItem(BOOKED_KEY, JSON.stringify(seen)); } catch (err) { /* ignore */ }

      var params = { method: "tidycal_embed", booking_id: id };
      if (typeof booking.booking_type_id === "number" || typeof booking.booking_type_id === "string") {
        params.booking_type_id = String(booking.booking_type_id);
      }
      track("generate_lead", params);
    } catch (err) {
      /* malformed message: ignore */
    }
  });

  // If the booking widget never renders, show a direct way to reach us.
  if (tidycal) {
    setTimeout(function () {
      if (tidycal.querySelector("iframe")) return;
      var note = document.getElementById("booking-fallback");
      if (note) note.hidden = false;
      track("booking_load_failed", {});
    }, 8000);
  }
})();

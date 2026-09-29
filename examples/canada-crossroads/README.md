# Canada: Crossroads

A Canadian history game built by the GangCode squad. After implementation, run `npm start` and open its printed loopback URL. See MISSION.md.

Indigenous histories precede the earliest selected event. These twelve events are not exhaustive; the stylized map is illustrative. Official sources appear with answer feedback.

Browser modules in `public/` are served as `text/javascript` at exactly two paths each: `/public/<name>.mjs` and the `/<name>.mjs` alias, for `atlas`, `timeline`, `cards`, `scoreboard`, `badges`, `sound`, `a11y`, `progress`, `glossary`, `itinerary`, `notebook`, `help`, `achievements` and `era-intro`. Every other path is a 404, including `/data/history.json` and anything that looks like an answer key.

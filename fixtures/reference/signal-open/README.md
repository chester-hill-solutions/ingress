# Signal

A lightweight first-party analytics platform: one tag, a small ingest, and a dashboard that
answers what is working and what is not.

## Run it

```sh
PORT=8080 node server.mjs
```

Then open <http://127.0.0.1:8080/dashboard> for the owner view.

## Embed the tag

Paste one line into every page of your site, before `</head>`:

```html
<script src="https://signal.example/signal.js" defer></script>
```

The server in this repository injects it into the demo pages for you, which is why `site/` is
never edited. Nothing a visitor types is read by the tag, and an element marked `data-private` is
never recorded.

## What the owner sees

Views per page, and the errors visitors hit, with counts. Nothing is sent to a third party.

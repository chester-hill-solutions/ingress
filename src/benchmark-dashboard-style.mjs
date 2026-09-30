/** Presentation only: statuses and rates are supplied by the evidence view. */
export const dashboardCSS = `
:root {
  color-scheme: dark;
  --bg: #101017;
  --surface: #191922;
  --raised: #20202b;
  --line: #343440;
  --text: #f1eff6;
  --muted: #b0adbf;
  --subtle: #8d899e;
  --accent: #b7b0fb;
  --live: #a8c9ff;
  --good: #9fddba;
  --warn: #f1cc8f;
  --bad: #f2aaa9;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg);
  color: var(--text);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 100px; }
body { margin: 0; }
button, input, select { font: inherit; }
button, summary, select { cursor: pointer; }
a { color: inherit; text-decoration: none; }
a:hover { color: var(--accent); }
:focus-visible { outline: 2px solid var(--live); outline-offset: 4px; }
button:disabled { cursor: default; opacity: .55; }
h1, h2, h3, p { margin: 0; }
h1 { font-size: clamp(26px, 3vw, 38px); line-height: 1.2; letter-spacing: -.035em; font-weight: 650; }
h2 { font-size: 18px; line-height: 1.35; letter-spacing: -.018em; font-weight: 600; }
h3 { font-size: 14px; font-weight: 600; }
small { font-size: 12px; }
.muted, .subtitle, .metric-note, .footnote { color: var(--muted); }
.mono, code { font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.app-shell { display: grid; grid-template-columns: 218px minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; padding: 32px 18px; border-right: 1px solid var(--line); background: #13131c; display: flex; flex-direction: column; gap: 32px; }
.brand { display: flex; flex-direction: column; gap: 5px; padding: 0 12px; font-size: 19px; font-weight: 650; letter-spacing: -.035em; }
.brand small { color: var(--subtle); font-weight: 450; letter-spacing: .06em; font-size: 10px; text-transform: uppercase; }
.sidebar nav { display: grid; gap: 6px; }
.nav-link { display: block; padding: 11px 12px; border: 1px solid transparent; border-radius: 8px; color: var(--muted); font-size: 13px; font-weight: 500; }
.nav-link:hover { background: #20202d; color: var(--text); }
.nav-link.active, .nav-link[aria-current='page'] { color: #ddd8ff; background: #272337; border-color: #45405d; }
.sidebar .footnote { margin-top: auto; padding: 0 12px; font-size: 11px; line-height: 1.7; }
.main { min-width: 0; padding: 0 40px 40px; max-width: 1800px; width: 100%; }
.page-header, .topbar { position: relative; z-index: 5; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 20px; padding: 30px 0 24px; margin-bottom: 28px; background: var(--bg); border-bottom: 1px solid var(--line); }
.eyebrow { display: block; margin-bottom: 9px; font-size: 10px; letter-spacing: .16em; font-weight: 650; text-transform: uppercase; color: var(--accent); }
.subtitle { margin-top: 10px; font-size: 13px; max-width: 750px; line-height: 1.65; }
section, .section { margin-bottom: 30px; scroll-margin-top: 20px; }
.section > h2 { margin-bottom: 14px; }
.badge, .status-pill { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 5px 10px; border-radius: 6px; border: 1px solid #444150; background: #25232f; color: #d0cadf; font-size: 11px; font-weight: 550; white-space: nowrap; line-height: 1.4; }
.badge.good, .status-pill.correct { color: var(--good); background: #1d2e26; border-color: #3b5b49; }
.badge.warn, .status-pill.deadline { color: var(--warn); background: #30291e; border-color: #655339; }
.badge.bad, .status-pill.failed { color: var(--bad); background: #332325; border-color: #684548; }
.badge.neutral, .status-pill.unknown { color: var(--muted); background: #24232b; border-color: var(--line); }
.badge.running, .status-pill.running { color: var(--live); background: #202b40; border-color: #415b7b; }
.metric-grid, .metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 22px; }
.metric-card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 20px; min-width: 0; }
.metric-label { display: block; color: var(--muted); font-size: 12px; font-weight: 500; margin-bottom: 12px; }
.metric-value { font-size: clamp(26px, 3vw, 36px); line-height: 1.15; font-weight: 600; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
.metric-value small { font-size: 16px; letter-spacing: 0; color: var(--muted); font-weight: 450; }
.metric-note { font-size: 11px; margin-top: 10px; line-height: 1.6; }
.panel { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden; margin-bottom: 22px; }
.panel-header, .panel-head { padding: 20px 22px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.panel-header p, .panel-head p { margin-top: 5px; font-size: 12px; color: var(--muted); }
.panel > .footnote { padding: 14px 22px; border-top: 1px solid var(--line); font-size: 11px; line-height: 1.7; }
.toolbar, .filter-bar { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--line); }
.filter-field { display: flex; flex-direction: column; gap: 6px; min-width: 160px; font-size: 11px; color: var(--muted); }
.filter-field label { font-weight: 550; }
select, .select, input { max-width: 100%; min-height: 37px; padding: 8px 11px; border-radius: 6px; background: #22222e; border: 1px solid #484554; color: var(--text); font-size: 12px; }
select:hover, input:hover { border-color: #716981; }
.button { display: inline-flex; align-items: center; justify-content: center; min-height: 37px; border-radius: 6px; background: #2a263a; border: 1px solid #57506f; color: #e1dcff; padding: 8px 13px; font-size: 12px; font-weight: 550; }
.button:hover:not(:disabled) { background: #38324e; border-color: #8e81b5; }
.progress-track { height: 7px; border-radius: 20px; overflow: hidden; background: #34313f; }
.progress-fill { height: 100%; background: var(--accent); border-radius: inherit; transition: width .25s ease; }
.progress-meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 10px 0 16px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.panel .progress-track { margin: 20px 22px 0; }
.panel .progress-meta { margin: 10px 22px 20px; }
.performance-grid { display: grid; gap: 18px; padding: 22px; }
.performance-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(100px, 3fr) auto; align-items: center; gap: 18px; font-size: 12px; }
.performance-track, .rate-bar { display: flex; height: 9px; min-width: 0; overflow: hidden; background: #3a3545; border-radius: 4px; }
.performance-fill { background: var(--good); height: 100%; }
.rate-segment { height: 100%; min-width: 0; }
.rate-segment.correct { background: #87c6a2; }
.rate-segment.deadline { background: #d5b074; }
.rate-segment.other { background: #d48d91; }
.rate-segment.pending { background: #514b62; }
.table-wrap { overflow: auto; max-height: 550px; overscroll-behavior: contain; scrollbar-color: #575264 transparent; }
.data-table, .comparison-table { width: 100%; border-collapse: separate; border-spacing: 0; text-align: left; font-size: 12px; }
.data-table th, .comparison-table th { position: sticky; top: 0; z-index: 2; background: #22212d; border-bottom: 1px solid #4b4558; padding: 13px 16px; font-size: 10px; color: #c3bdcf; text-transform: uppercase; letter-spacing: .07em; white-space: nowrap; font-weight: 600; }
.data-table td, .comparison-table td { border-bottom: 1px solid #30303c; padding: 15px 16px; vertical-align: middle; font-variant-numeric: tabular-nums; }
.data-table tbody tr:last-child td, .comparison-table tbody tr:last-child td { border-bottom: 0; }
.data-table tbody tr:hover, .comparison-table tbody tr:hover { background: #23222e; }
.data-table td:first-child, .comparison-table td:first-child { font-weight: 550; }
.data-table td .muted, .comparison-table td .muted { display: block; font-size: 11px; margin-top: 3px; font-weight: 400; }
.data-table .rate-bar, .comparison-table .rate-bar { min-width: 110px; margin: 7px 0; }
.activity-list { display: grid; }
.activity-item, .cohort-card { border-bottom: 1px solid var(--line); min-width: 0; }
.activity-item:last-child, .cohort-card:last-child { border-bottom: 0; }
.cohort-toggle, .cohort-summary { display: flex; justify-content: space-between; align-items: center; gap: 16px; width: 100%; padding: 18px 22px; color: var(--text); text-align: left; background: transparent; border: 0; }
.cohort-toggle:hover, summary.cohort-summary:hover { background: #23222e; }
.cohort-summary > div { min-width: 0; }
.cohort-summary strong { font-size: 13px; font-weight: 600; }
.cohort-summary .muted { display: block; font-size: 11px; margin-top: 4px; }
.cohort-detail { padding: 0 22px 22px; background: #171720; }
.actor-grid, .actor-roster { display: grid; grid-template-columns: repeat(auto-fit, minmax(205px, 1fr)); gap: 10px; padding-top: 16px; }
.actor-card { min-width: 0; padding: 14px; border: 1px solid var(--line); background: var(--surface); border-radius: 7px; font-size: 11px; }
.actor-name { font-size: 12px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.actor-card p { margin-top: 6px; color: var(--muted); overflow-wrap: anywhere; }
.metadata-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; padding: 20px 22px; margin: 0; font-size: 12px; }
.metadata-grid dt { color: var(--muted); font-size: 10px; margin-bottom: 5px; letter-spacing: .04em; text-transform: uppercase; }
.metadata-grid dd { margin: 0; overflow-wrap: anywhere; }
details.disclosure { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; margin-top: 16px; }
details.disclosure > summary { padding: 15px 20px; font-size: 12px; color: var(--muted); }
details[open] > summary { color: var(--text); }
details p, details pre { overflow-wrap: anywhere; }
details pre { white-space: pre-wrap; max-height: 260px; overflow: auto; padding: 16px; font-size: 11px; background: #121219; border-radius: 6px; }
.empty-state { padding: 46px 24px; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.8; }
.empty-state strong { display: block; color: var(--text); margin-bottom: 5px; font-weight: 550; }
.footnote { font-size: 11px; line-height: 1.7; }
@media (min-width: 1600px) { .main { padding-right: 56px; padding-left: 56px; } }
@media (max-width: 1150px) { .app-shell { grid-template-columns: 180px minmax(0, 1fr); } .main { padding: 0 24px 30px; } .metric-grid, .metrics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  html { scroll-padding-top: 20px; }
  .app-shell { display: block; }
  .sidebar { position: static; height: auto; padding: 18px 20px 12px; border-right: 0; border-bottom: 1px solid var(--line); gap: 16px; }
  .brand { padding: 0; font-size: 17px; }
  .sidebar nav { display: flex; gap: 5px; overflow-x: auto; }
  .nav-link { white-space: nowrap; padding: 8px 10px; font-size: 12px; }
  .sidebar .footnote { display: none; }
  .main { padding: 0 18px 28px; }
  .page-header, .topbar { position: static; padding: 24px 0 20px; gap: 14px; margin-bottom: 20px; }
  .section { scroll-margin-top: 20px; }
  .metric-card { padding: 16px; }
  .panel-header, .panel-head, .toolbar, .filter-bar { padding: 16px; }
  .filter-field { flex: 1 1 150px; min-width: 0; }
  .filter-field select { width: 100%; }
  .performance-row { grid-template-columns: minmax(100px, 1fr) minmax(80px, 2fr) auto; gap: 10px; }
  .performance-grid { padding: 16px; }
  .cohort-toggle, .cohort-summary { padding: 16px; gap: 10px; align-items: flex-start; }
  .cohort-detail { padding: 0 16px 16px; }
  .data-table th, .comparison-table th, .data-table td, .comparison-table td { padding: 12px; }
  .metadata-grid { padding: 16px; }
}
@media (max-width: 420px) { .metric-grid, .metrics-grid { gap: 10px; } .metric-value { font-size: 26px; } .metric-note { font-size: 10px; } .actor-grid, .actor-roster { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { transition: none !important; animation: none !important; } }
`;

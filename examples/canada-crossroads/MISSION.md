# Canada: Crossroads

Ingress is the collaborating squad name. Build Canada: Crossroads, a playful Canadian history exploration game, with Node built-ins, ES modules and browser APIs only. Use native file tools; the harness executes and verifies. No dependencies, remote assets, services or credentials. Files are preferred focus, not claims: cross-module edits are allowed when needed. Inspect live peer contracts.

## Canonical content

data/history.json contains twelve root-researched events {id,title,year,era,region,question,options:[{id,text}],correctOptionID,explanation,source:{title,url},x,y}. Preserve id/year/era/question/options/correctOptionID/explanation/source exactly. Content specialist may polish only title/region/x/y and standalone introduction. Eras: early-contact, confederation, modern. Do not invent facts or citations. Coordinates 0..100 are illustrative, not surveyed borders. Vimy Ridge is overseas: its x94/y12 marker belongs in a clearly labelled France inset, not in Canada. Indigenous histories precede the earliest selected event, around1000; the twelve events are not exhaustive. Official sources appear after answers.

## Engine

engine.mjs exports createGame({events,seed=1}={}) -> {snapshot(),chooseEra(era),answer(eventID,optionID),restart(),subscribe(fn)}. subscribe returns unsubscribe. Default era early-contact; sort selected events by year then id, no shuffle. Seed is reserved for reproducibility. Do not mutate supplied data. Reject duplicate event/option IDs and missing correct option relationships during construction. Reject unknown eras, invalid options, repeated answers and answers for non-current events atomically.

snapshot deep-clones {phase:'playing'|'complete',era,score,streak,answered:[{eventID,optionID,correct}],currentEvent,feedback:null|{eventID,correct,explanation,source},progress:{answered,total},milestones:[{id,title,unlocked}],mapEvents:[publicEvent],revision}. Initial revision/score/streak=0, answered=[], feedback=null. Public events exclude correctOptionID AND explanation; mapEvents includes the selected era, currentEvent is next unanswered or null on completion. Only feedback after an answer can expose that event's explanation. Sources must remain official provided source links.

Correct answer earns 10+min(previousStreak,3)*2, increments streak; wrong earns0 and resets streak0. Record once, immediately advance currentEvent, retaining last-answer feedback beside the next question. Complete after all era events; empty eras are complete with zero progress. chooseEra resets score/streak/answers/feedback/milestones; restart resets same era. Every successful mutation increments revision, returns the new snapshot and synchronously notifies subscribers with fresh snapshots. Unsubscribe stops notifications. Rejected operations change nothing.

Milestones EXACT: first-steps ('First Steps') unlocked when answered>=1 even if wrong; streak-three ('Sharp Eye') latches once streak reaches3 until reset; chapter-complete ('Chapter Complete') unlocked on complete.

## HTTP/SSE

server.mjs exports async createGameServer({events,host='127.0.0.1',port=0}={}) -> {url,close}. Omitted events load data/history.json relative to server.mjs (JSON array, or events array in an envelope). Only loopback bind hosts127.0.0.1/::1/localhost. close asynchronously releases SSE/listener and is idempotent. Direct node server.mjs starts, prints URL and handles SIGINT/SIGTERM cleanup.

GET / serves public/index.html; GET /state snapshot JSON; GET /events text/event-stream initialsnapshot then subscribed snapshots with disconnect cleanup. POST /answer {eventID,optionID}; POST /era {era}; POST /restart. All successful POST responses are new snapshots. JSON bodies bounded64KiB. Invalid inputs HTTP400 shortJSONerror/no stacks; unknownpaths404. Raw /data/history.json and all answer-key routes404. Omitted Origin allowed; an Origin must match THIS server's own loopback origin, otherwise403. Never wildcard CORS. Initial/state/map/SSE public data must exclude correctOptionID/explanation; post-answer feedback alone exposes explanation.

## Browser

A playful, richly illustrated paper/ink/red/copper journey, not an admin panel. Stylized Canada SVG terrain/water, region markers and labelled overseas Vimy France inset, chronological timeline, three-era selector, question/choice cards, score/streak/progress, milestone badges, prominent last-answer feedback plus officialsource link beside nextcurrent question, finalchapter/restart flow. Map positions explicitly illustrative. Use EventSource('/events') plus initial GET/state; post documented actions. Show truthful connection/loading/errors. Keyboard-accessible buttons/focus, responsive mobile. Safe DOM textContent for dynamic strings. Do not fetch rawhistory or embed answerkeys. A local Next feedback-dismissal button may toggle presentation, but server already advanced currentEvent. Show nuanced sample intro and sources without inventing history.

README: npm start, printed loopback URL, gameplay/API and sample/illustrative-map limitations. Independent verification stays outside this project. Seed functions are intentionally unfinished; real specialists implement them.


## Coordinator browser QA observation

Independent interactive QA (after the sixteen builders stopped): clicking the initial L’Anse aux Meadows choice leaves its buttons disabled and displays `TL IS NOT DEFINED`. The request appears to reach the server, but UI rendering fails. In public/index.html, drawEras reads an undeclared `tl`; the live timeline handle is not stored in that name. Repair this concrete browser failure along with the remaining duplicate snapshot SSE frame. Preserve question/answer facts and component behavior. Review the field-notes wiring: Notebook and Glossary headings were visible without content at initial load. Also correct the early-contact introduction: wrong answers award zero points; they do not subtract earned score. This note records actual QA, not a hidden evaluator implementation.

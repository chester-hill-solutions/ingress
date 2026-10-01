# Competition submission protocol and compliance

**Date:** 2026-10-01. **Sources:** [challenge page](https://www.cloudflare.com/git-competition/),
[submission form](https://www.cloudflare.com/git-competition/submit), and the
[Official Rules PDF](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
retrieved 2026-10-01. Questions to `git-competition@cloudflare.com`.

This is a reading of the rules against our actual repository as it stands. It
records what passes, what fails, and two findings that change the
[platform plan](cloudflare-platform-plan.md).

## Deadline

**2026-10-14 at 11:59 PM PDT.** Contest opened 2026-10-01 09:00 EDT. Sponsor's
computer is the official timekeeper. This is a specific timestamp, not "end of
October 14", and PDT is not the local clock in every timezone — worth pinning a
reminder rather than trusting the date.

## Eligibility

- Legal resident of the United States or Canada.
- 18 or older as of the start time.
- Not a Cloudflare employee, officer, director, or immediate family.
- **Void outside the US and Canada**, so the team must be resident in one of them.
- **One submission per entrant.**

## Required form fields

Team: name, primary contact name, primary contact email, team location, first
attendee name and email, optionally second attendee name and email.

Project: name, project vision, and **"How you used Cloudflare"**.

Demo and source: demo video, open source repository URL, instructions to run.

Two confirmations: that the project was built using **Cloudflare Workers and
Artifacts**, and that the submission follows the competition terms.

Video must be **MP4, WebM or MOV, maximum 2 GiB**.

Submissions and video are retained for up to 180 days.

## Submission Criteria, checked against this repository

| Criterion | Status | Evidence |
| --- | --- | --- |
| Entrant's own original content, no plagiarism, no unlicensed third-party material or artwork | **Pass** | Zero tracked media assets. All external URLs are Government of Canada citations in a history fixture. Material transferred from `stow` is same-organisation, Apache-2.0, and itemised with SHA-256 in `docs/source-provenance.json` |
| Must use Workers and Artifacts, enabling multiple agents working concurrently | **Pass** | Artifacts exercised end to end in the [spike report](artifacts-spike-report.md); the Workers/DO half is the next build step |
| Licence must be MIT, Apache-2.0, or BSD 2/3-Clause, **with a LICENSE file in the repository** | **Pass** | `LICENSE` is the full Apache-2.0 text; GitHub reports `apache-2.0` |
| No personal attacks or disparagement of any product, including competitors | **Pass** | Negative results are about our own product, not named competitors |
| No weapons, sexual, political or illegal content | **Pass** | — |

## Blocking gaps

**1. The repository is private.** `chester-hill-solutions/gangcode` reports
`visibility: PRIVATE`. The form requires an open source repository URL and
Section 9 obliges the entrant to provide Sponsor access to the complete source
code in order to administer and judge the contest. This must be made public
before submission and is the single hardest gate.

**2. `package.json` has no `license` field** and is marked `"private": true`.
The `private` flag only affects npm publishing, so it is not itself a rule
violation, but it contradicts the submission and should be corrected for
consistency with the `LICENSE` file.

## Two findings that change the plan

### The judging rubric is published, and 25% of it is product experience

Finalists are chosen on three criteria, each scored 1–5, ties broken on the first:

| Weight | Criterion |
| --- | --- |
| **50%** | Originality and quality of the prototype for agent-oriented software collaboration |
| **25%** | Effectiveness of multi-agent concurrency, coordination, context preservation, review, and conflict handling |
| **25%** | Ease of use and product/user experience |

Criterion 2 is precisely what this project is about, which is a strong fit.

Criterion 1 at half the weight creates a real tension with our framing. Leading
with "coordination is a correctness instrument, not a speed instrument" and
publishing results where eight-agent teams produced 8 correct artifacts with 0
of 9 completions in budget reads, to a judge scoring *quality of the prototype*,
either as deliberate rigour or as an unfinished prototype. It has to be presented
as the former, which means the artifact must be visibly complete: the run
instructions have to work first time, the demo has to be reproducible, and the
negative results must arrive with the mechanism that explains them, not instead
of one.

Criterion 3 at 25% is a genuine scope gap. The plan currently lists a hosted
control plane and multi-agent product surface as out of scope, and treats the
evidence-trail view as a minor step. A quarter of the score is user experience,
so the P0 demo path has to be legible to someone who has not read the docs, even
if the surrounding product is never built. This should be resolved deliberately
rather than discovered.

### The winner must be physically present

Section 7: potential winners must be physically present at Cloudflare Connect to
be eligible. Connect is 2026-10-21 at Moscone West, San Francisco. Finalists get
ten minutes on stage, and Cloudflare covers travel and hotel for up to two people
per team — passports, visas, meals and incidentals are not covered. That is a
real constraint on who can take this through to a win, and it should be settled
before the work is finished rather than after.

## Submission mechanics

The form states everything can be reviewed before upload begins. Because the
video is capped at 2 GiB and must be MP4/WebM/MOV, the deterministic capture
harness in `chester-hill-solutions` `packages/demo-video` produces mp4 directly
and avoids a screen recording, which is the right tool if that tree is reachable.
That tree is 69 commits behind with 70 uncommitted files, so this remains
optional rather than assumed.

Recommended order, so nothing is discovered late:

1. Make the repository public and rename the remote off `gangcode`.
2. Push the review branch.
3. Produce the video and verify it is under 2 GiB.
4. Write the run instructions and confirm they work from a clean checkout.
5. Draft "How you used Cloudflare" and the project vision.
6. Fill the form, review, upload.

## Note on the required Cloudflare statement

The form asks to confirm the project was built using Cloudflare Workers and
Artifacts. It was: Artifacts is the repository substrate with a measured event
path, exercised against a live account. The Workers and Durable Object layer is
still to be built, so the confirmation should be made once that half is deployed
rather than now.
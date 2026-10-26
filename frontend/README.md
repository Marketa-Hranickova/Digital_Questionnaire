# VFQ-25 iPad interface (Person A)

Plain HTML, CSS and JavaScript, no build step. Renders `../questionnaire.json` one item per
screen and submits a FHIR QuestionnaireResponse to the proxy server (`server/README.md`).

| File | What it is |
|---|---|
| `index.html` | Page shell |
| `app.js` | Screens, branching, read-aloud, API calls |
| `styles.css` | Colour themes, font sizes, layout |
| `fonts/` | Atkinson Hyperlegible Next (SIL OFL), self-hosted so the iPad never contacts Google |

## Run locally (with the mock server)

Two terminals, both in the repository root:

```bash
STAFF_PIN=482913 ALLOWED_ORIGINS=http://localhost:8000 uvicorn server.app:app --port 8080
python3 -m http.server 8000
```

Open <http://localhost:8000/frontend/>. The server address defaults to
`http://localhost:8080`; another one can be passed as `?api=https://…`.
**For deployment** set `DEPLOYED_API` at the top of `app.js`: then `?api=` and the address field
are ignored, so a crafted link cannot redirect the PIN and answers to another server.
Opening `index.html` as a file does not work, because the browser blocks loading
`questionnaire.json` from disk.

**Demo without server:** tick "Demo ohne Server" on the staff screen. Nothing is sent; the last
screen shows the QuestionnaireResponse the server would receive. This is what works on GitHub
Pages (enable Pages from the repository root; the page is then at `…github.io/Digital_Questionnaire/frontend/`).
A Pages site (HTTPS) cannot call a local HTTP server, so a full iPad test needs the server
behind HTTPS too.

## Flow

1. **Staff:** patient code (`P` + 4–6 digits, same rule as the server), options appendix A3–A8 and
   skip Q1, PIN → `POST /api/sessions`. The PIN is not kept after this step.
2. **Hand-over:** one full-screen "tap anywhere" button. Browsers only allow audio after a touch,
   so this tap is what unlocks read-aloud for blind patients.
3. **How do you want to answer?** Spoken aloud, three large buttons:
   - *Vorlesen*: German speech (Web Speech API, prefers a de-AT voice). Tap an answer once to hear
     it, tap again to choose; the next question is read automatically.
   - *Eigener Screenreader*: no speech from the page, so it does not talk over VoiceOver.
     Answers are real radio buttons (`role="radio"`, `aria-checked`).
   - *Selbst lesen*: display settings first: 4 font sizes, 3 colour themes
     (black on white, white on black, yellow on black), live preview.
4. **Questions:** one per screen, underlining from the paper form kept (`rendering-xhtml`, only
   `<u>` and `<br>` are allowed through). Weiter stays disabled until an answer is chosen.
   `enableWhen` branching; answers of items that become hidden are deleted.
   "Pflege rufen" and "Einstellungen" on every screen. Keyboard: 1–6 answer, R repeats.
5. **Staff review:** PIN again (`POST /api/staff/check`), all answers, missing ones highlighted,
   "Ändern" jumps back (and returns to the review afterwards, or to a newly enabled follow-up
   first). "Ändern" forgets the PIN, so if the iPad goes back to the patient, the review asks
   for it again.
6. **Send:** `POST /api/responses`. On `401` (session expired) it opens a new session with the
   review PIN and retries once; if that fails too, it asks for the PIN again. `422` and `502`
   keep the answers so staff can fix or resend.
7. **Done:** PDF from `GET /api/records/{pid}/pdf`, then "Nächste Person starten" wipes
   everything, including the patient's display settings.

## Privacy

Nothing is written to localStorage, sessionStorage, cookies or IndexedDB. Token, PIN and answers
live only in memory and are cleared after sending and on "Nächste Person starten".
Requests use `cache: 'no-store'` and `credentials: 'omit'`.

## Tested

Automated browser run (Chromium) against the mock server: all three driving paths store
27 / 26 / 25 answers, appendix + skip Q1 stores 32, and changing Q15 on the review screen
correctly asks 15a and drops 15c/16/16a. No browser storage used; no horizontal scrolling at
phone width. **Not yet tested on a real iPad with Safari and VoiceOver.**

## Open points

- **Wording to check in `questionnaire.json`:** Q15 still starts with the interviewer phrase
  "Jetzt möchte ich Ihnen einige Fragen … stellen"; Q4 ends with "haben sie?" (lower-case *sie*).
- **Offline:** the questionnaire is loaded once; answers are lost if the page is reloaded.
  A service worker could cache the app for unstable Wi-Fi.
- **"Pflege rufen"** only shows a message on the iPad; it does not notify anyone yet.
- PDF via print stylesheet (TASKS.md) is not done; the server's REDCap PDF is used instead.

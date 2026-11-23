# VFQ-25 proxy server

Sits between the iPad UI and REDCap. It holds the REDCap API token, checks every submission
against `questionnaire.json` and never lets the browser talk to REDCap directly.

```
iPad UI ──HTTPS──> proxy (this server, holds token) ──HTTPS──> REDCap API at MUG
```

## Run locally (mock REDCap, no access needed)

```bash
pip install -r server/requirements.txt
STAFF_PIN=482913 uvicorn server.app:app --reload --port 8080
python3 -m pytest tests/          # 48 tests: converter + server
```

`REDCAP_MODE=mock` (default) keeps records in memory and returns a one-page placeholder PDF.
The server refuses to start with a non-HTTPS URL, a malformed token or a PIN shorter than
6 digits.

## Connect to the real REDCap

1. **Project:** import `redcap/vfq25_data_dictionary.csv` (*Project Setup → Dictionary*) and
   switch off *Auto-numbering for records*. Your user needs the rights *API Export* and
   *API Import/Update* (*User Rights*), then create the token on the project's *API* page.
   The token belongs to one project and one user.
2. **Settings file outside the repository**, for example `~/vfq25.env`:
   ```bash
   export REDCAP_MODE=redcap
   export REDCAP_API_URL=https://<redcap-host>/api/
   export REDCAP_API_TOKEN=<32-character token>
   ```
   `<redcap-host>` is the host name shown in the browser while you use REDCap (the API address
   is that host plus `/api/`). The server does **not** read `.env` files; it only reads
   environment variables, so load the file with `source`.
3. **Check the address without a token:** the right address answers with HTTP 403, a wrong
   path with 404:
   ```bash
   source ~/vfq25.env
   curl -s -o /dev/null -w "%{http_code}\n" -d "content=version" "$REDCAP_API_URL"
   curl -s -o /dev/null -w "%{http_code}\n" -d "content=version" "${REDCAP_API_URL}xyz"
   ```
4. **Check the token** (this prints project information, not the token):
   ```bash
   curl -sS --http1.1 -d "token=$REDCAP_API_TOKEN" -d content=project -d format=json "$REDCAP_API_URL"
   ```
   `--http1.1` matters: with the default HTTP/2, current curl versions fail on this server with
   "Invalid HTTP header field ... upgrade" (error 92), although the request itself succeeded.
5. **Start the server** in the same terminal:
   ```bash
   source ~/vfq25.env
   STAFF_PIN=482913 ALLOWED_ORIGINS=http://localhost:8000 uvicorn server.app:app --port 8080
   ```
   `GET /api/health` then reports `"mode":"redcap"`.

Never commit or paste the token anywhere (chat, screenshots, issues). If it was exposed,
use *Regenerate token* on the API page and update your settings file.

Typical errors: `502` from `/api/responses` with `REDCap returned HTTP 403` in the server log
means REDCap rejected the token (wrong or old token, or wrong host); the response
`{"error":"You do not have permissions to use the API"}` comes from REDCap and has the same
causes. The API Playground inside REDCap shows quickly whether a token works.

## API (contract for the frontend)

| Method + path | Who | Auth | Body / result |
|---|---|---|---|
| `POST /api/sessions` | staff, on the iPad | header `X-Staff-Pin` | `{"pid":"P0012","include_appendix":false,"skip_q1":false}` → `201 {"token","expires_in"}` |
| `POST /api/staff/check` | staff, before the review | header `X-Staff-Pin` | `204` if the PIN is right, `401`/`429` otherwise |
| `POST /api/responses` | patient UI | header `Authorization: Bearer <token>` | FHIR QuestionnaireResponse → `201 {"stored":true,"answers":n}` |
| `GET /api/records/{pid}/pdf` | staff | header `X-Staff-Pin` | PDF for the hospital record |
| `GET /api/health` | anyone | none | `{"status":"ok","mode":"mock"}` |

Flow: staff enters PIN + code → the UI keeps the token in memory (never in localStorage) →
patient answers → UI posts the QuestionnaireResponse it already builds → token is consumed.
A rejected submission (`422`) keeps the session open so the answers can be fixed and resent;
a REDCap outage (`502`) also keeps it open for a retry.

**Keep in sync:** the server accepts patient codes only as `P` + 4–6 digits (`PID_PATTERN`).
The staff screen in `frontend/` uses the same pattern; if one side changes, change the other,
otherwise the server rejects the session with 422.

## Security decisions

| Threat | Protection |
|---|---|
| Token stolen from the iPad | Token lives only in server env; the iPad gets a one-time session token |
| Name typed instead of code | Strict pseudonym pattern on session start and on submit |
| Forged answers (curl, devtools) | Server checks item IDs, allowed codes, branching, appendix/Q1 options, completeness |
| Answers sent for another patient | Response code must match the session's code |
| Replay / double submit | Session token works once, expires after 2 h |
| PIN guessing | Constant-time compare, lockout after 5 wrong PINs for 5 min |
| Data cached on the device | `Cache-Control: no-store` on every response |
| Pseudonyms in log files | Logs show an 8-char hash, never the code or answers |
| Large/abusive requests | 64 KB body limit (repeat it in the reverse proxy) |
| API discovery | No `/docs`, `/redoc` or `/openapi.json` |

## Not done yet

- Deployment: behind an HTTPS reverse proxy (nginx) on a MUG/KAGes server; where it may run
  is still an open question.
- Real REDCap test: run against the development project once access is granted
  (`import record`, `export pdf`).
- Shared state: sessions and PIN lockout are in memory, so run a single worker.
- Per-IP rate limiting and an audit log of staff actions.

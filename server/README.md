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
python3 -m pytest tests/          # 46 tests: converter + server
```

`REDCAP_MODE=mock` (default) keeps records in memory and returns a placeholder PDF.
Switch to the real API with `REDCAP_MODE=redcap`, `REDCAP_API_URL` and `REDCAP_API_TOKEN`
(see `.env.example`). The server refuses to start with a non-HTTPS URL, a malformed token
or a PIN shorter than 6 digits.

## API (contract for the frontend)

| Method + path | Who | Auth | Body / result |
|---|---|---|---|
| `POST /api/sessions` | staff, on the iPad | header `X-Staff-Pin` | `{"pid":"P0012","include_appendix":false,"skip_q1":false}` → `201 {"token","expires_in"}` |
| `POST /api/responses` | patient UI | header `Authorization: Bearer <token>` | FHIR QuestionnaireResponse → `201 {"stored":true,"answers":n}` |
| `GET /api/records/{pid}/pdf` | staff | header `X-Staff-Pin` | PDF for the hospital record |
| `GET /api/health` | anyone | none | `{"status":"ok","mode":"mock"}` |

Flow: staff enters PIN + code → the UI keeps the token in memory (never in localStorage) →
patient answers → UI posts the QuestionnaireResponse it already builds → token is consumed.
A rejected submission (`422`) keeps the session open so the answers can be fixed and resent;
a REDCap outage (`502`) also keeps it open for a retry.

**Frontend change needed:** the server accepts patient codes only as `P` + 4–6 digits
(`PID_PATTERN`). The staff screen in the frontend must accept the same format;
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

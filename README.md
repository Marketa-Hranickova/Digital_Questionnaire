# VFQ-25 digital

4Health Problem 3: a digital, accessible version of the NEI VFQ-25 visual function
questionnaire for the Univ.-Augenklinik Graz. The repository holds the questionnaire
definition, the proxy server that stores answers in REDCap (Person B: data, server, security)
and the iPad interface (Person A). The interface talks to the server over the API described
in `server/README.md`.

## Contents

| Path | What it is |
|---|---|
| `questionnaire.json` | NEI VFQ-25 (German for Austria) as a FHIR R4 Questionnaire. Shared contract with the frontend: item IDs, answer codes, branching. |
| `tools/fhir_to_redcap.py` | Generates the REDCap data dictionary from `questionnaire.json` |
| `redcap/vfq25_data_dictionary.csv` | Generated data dictionary, ready to import into REDCap |
| `server/` | Proxy server between the iPad and REDCap (FastAPI): sessions, validation, REDCap API |
| `frontend/` | iPad interface that works with the server (see `frontend/README.md`) |
| `patient-interface/` | Newer accessible patient interface (single page, work in progress, not yet connected to the server) |
| `tests/` | 48 automated tests for the converter and the server |
| `TASKS.md` | Task split for the whole team |

## Quick start

```bash
pip install -r server/requirements.txt
python3 -m pytest tests/                                        # run all tests
STAFF_PIN=482913 uvicorn server.app:app --reload --port 8080    # server with mock REDCap
python3 tools/fhir_to_redcap.py questionnaire.json redcap/vfq25_data_dictionary.csv
```

The server reads its settings only from environment variables. For the real REDCap, keep them
in a file **outside** the repository and never commit them; see "Connect to the real REDCap"
in `server/README.md`.

## Questionnaire definition

- **35 items**: Q1–Q14, Q15, 15a, 15b, 15c, Q16, 16a, Q17–Q25, A3–A8. `linkId`s: `q01`…`q25`,
  `q15a`, `q15b`, `q15c`, `q16a`, `a3`…`a8`. Answer codes are the numbers printed on the paper
  form, so data stays comparable with earlier paper-based research.
- **Raw answers only.** Scale direction differs (Q1–16a: 1 = best; Q17–25: 1 = worst); scoring
  is a separate step.
- **Branching** (`enableWhen`): 15 = Ja → 15c, 16, 16a; 15 = Nein → 15a; 15a = "Lenke nicht
  mehr" → 15b.
- **Modifications vs. the paper form** (RAND licence: changes must be identified): every
  changed text carries a `modification-note` extension and the original wording. Open item:
  check whether an official self-administered German VFQ-25 exists and use its wording.

## REDCap data dictionary

`tools/fhir_to_redcap.py` turns `questionnaire.json` into 40 REDCap fields in two instruments:
`vfq_questionnaire` (record ID = pseudonym, intro texts, Q1–Q25) and `vfq_appendix` (A3–A8,
switchable). Choice → `radio`, display → `descriptive`, `enableWhen` → branching logic such as
`[q15] = '1'`, modification notes → Field Annotation. The closing sentence is printed for
*Survey Settings → Survey completion text*. Import via *Project Setup → Data Dictionary*;
use `--no-html` if REDCap shows the `<u>` tags as text. **Switch off "Auto-numbering for
records"** in *Project Setup → Enable optional modules*, so that the pseudonym code (for
example `P0012`) can be used as record ID.

## Server and security

See `server/README.md` for the API contract, the security decisions and what is still open.
The threat model is kept as a separate team document.

---
The NEI VFQ-25 was developed at RAND under the sponsorship of the National Eye Institute.

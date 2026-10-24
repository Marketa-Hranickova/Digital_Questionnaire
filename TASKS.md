# VFQ-25 digital – technical task split

Everything starts from zero. Person A owns the patient and staff interface (frontend);
Person B owns data, server and security (backend + security).

Key dates: version 1.0 frozen on **8 Jan 2027**, pitch on **16 Jan 2027**.

## Together – week 1

- [ ] Create the Git repository: project structure, README, tasks as issues
- [ ] Choose the stack: plain HTML/JS or a framework (React, Svelte)
- [ ] Convert the paper NEI VFQ-25 into a **FHIR Questionnaire** (JSON): 35 items, unique IDs,
      answer codes as printed on paper, branching for Q15–16a. One writes, the other checks it
      against the PDF
- [ ] Agree on the output format: FHIR QuestionnaireResponse

## Person A – patient and staff interface (frontend)

- [ ] Load the questionnaire from JSON and show one question per screen
- [ ] Branching (`enableWhen`); clear answers of items that become disabled
- [ ] Accessibility: 4 font sizes, 3 colour themes, large tap targets, read-aloud
      (Web Speech API, German voice), works in Safari on iPad
- [ ] Navigation: Weiter, Zurück, progress bar; Weiter disabled until an answer is chosen
- [ ] Staff start screen (patient code, options: appendix A3–A8, skip Q1) and patient
      display-settings screen
- [ ] Staff review screen: all answers, missing ones highlighted, jump back to an item
- [ ] PDF output: print stylesheet or in-browser PDF generation
- [ ] Tests on a real iPad with large fonts and simulated low vision

## Person B – data, server and security (backend + security)

- [ ] Request REDCap access at MUG (development project + API rights); fallback: LimeSurvey
- [ ] Script that generates the **REDCap data dictionary (CSV)** from the FHIR JSON; import it
      and check branching and answer codes
- [ ] **Proxy server** that holds the REDCap API token:
  - [ ] endpoint that accepts a QuestionnaireResponse, validates it and writes it to REDCap
        (import records)
  - [ ] endpoint that returns the PDF from REDCap (export PDF)
  - [ ] token only in environment variables, never in code or in the browser
- [ ] Input validation: patient code only in the format `P0012`, no names; answers must match
      the allowed codes
- [ ] Staff login or PIN before the review and export screens
- [ ] HTTPS, least-privilege API user, logging without personal data
- [ ] Client-side privacy review of Person A's code: nothing stored on the iPad
      (no localStorage, sessionStorage or cookies); memory wiped after completion
- [ ] Security tests: entering a name, forged answers, opening the review without PIN,
      extracting the token
- [ ] Data-flow and privacy documentation for the clinic: who sees what, where data lives,
      key table (name ↔ code) kept outside the system

## Together – end of semester

- [ ] Connect the frontend to the proxy and test the full flow: iPad → REDCap → PDF
- [ ] Automated tests for all three branching paths (drives / stopped driving / never drove)
- [ ] Clinic testing with nurses and patients; fix findings
- [ ] Freeze version 1.0 (8 Jan), pitch demo (16 Jan), one-page staff guide, handover

## Dependencies

- Person A can start immediately with test data.
- Person B depends on REDCap access: send the request in week 1 and build the proxy against
  a mocked REDCap API until access arrives.
- Frontend ↔ proxy integration starts around mid-November, once both sides work on their own.
- If Person A wants more backend work, the PDF output can move to Person B.

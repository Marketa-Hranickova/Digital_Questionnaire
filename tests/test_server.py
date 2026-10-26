"""Tests for the proxy server (mock REDCap). Run with: python3 -m pytest tests/"""
import json
import pathlib
import sys

import pytest
from fastapi.testclient import TestClient

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.app import create_app  # noqa: E402
from server.config import Settings  # noqa: E402
from server.redcap import MockRedcap  # noqa: E402

PIN = "482913"
QUESTIONNAIRE = json.loads((ROOT / "questionnaire.json").read_text(encoding="utf-8"))


def make_client(**overrides):
    settings = Settings(staff_pin=PIN, questionnaire_path=ROOT / "questionnaire.json",
                        **overrides).validate()
    redcap = MockRedcap()
    return TestClient(create_app(settings, redcap)), redcap


@pytest.fixture
def client():
    return make_client()


def start(client, pid="P0012", **opts):
    r = client.post("/api/sessions", json={"pid": pid, **opts}, headers={"X-Staff-Pin": PIN})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def build_response(pid="P0012", answers=None, status="completed", appendix=False,
                   drop=(), questionnaire=QUESTIONNAIRE):
    """A QuestionnaireResponse shaped like the one the patient UI produces.

    Default path: drives a car (Q15 = 1 -> 15c, 16, 16a), every other answer = 1.
    """
    answers = dict(answers or {})
    answers.setdefault("q15", "1")
    given = {}

    def enabled(it):
        return all(given.get(c["question"]) == c["answerCoding"]["code"]
                   for c in it.get("enableWhen", []))

    def walk(items):
        out = []
        for it in items:
            if it["type"] == "group":
                if it["linkId"] == "appendix" and not appendix:
                    continue
                children = walk(it["item"])
                if children:
                    out.append({"linkId": it["linkId"], "item": children})
            elif it["type"] == "choice" and enabled(it) and it["linkId"] not in drop:
                code = answers.get(it["linkId"], "1")
                given[it["linkId"]] = code
                out.append({"linkId": it["linkId"],
                            "answer": [{"valueCoding": {"code": code}}]})
        return out

    return {
        "resourceType": "QuestionnaireResponse",
        "questionnaire": f"{questionnaire['url']}|{questionnaire['version']}",
        "status": status,
        "subject": {"identifier": {"system": "urn:4health:pseudonym", "value": pid}},
        "item": walk(questionnaire["item"]),
    }


def submit(client, token, body):
    return client.post("/api/responses", json=body, headers={"Authorization": f"Bearer {token}"})


# --- happy paths -------------------------------------------------------------------

def test_health_has_no_data(client):
    c, _ = client
    assert c.get("/api/health").json() == {"status": "ok", "mode": "mock"}


@pytest.mark.parametrize("answers,expected", [
    ({"q15": "1"}, 27),                  # drives: 15c, 16, 16a (29 items minus 15a, 15b)
    ({"q15": "2", "q15a": "2"}, 26),     # stopped driving: 15a, 15b
    ({"q15": "2", "q15a": "1"}, 25),     # never drove: 15a only
])
def test_all_branching_paths_are_stored(client, answers, expected):
    c, redcap = client
    token = start(c)
    r = submit(c, token, build_response(answers=answers))
    assert r.status_code == 201, r.text
    record = redcap.records["P0012"]
    assert len([k for k in record if k.startswith("q")]) == expected
    assert record["vfq_questionnaire_complete"] == "2"


def test_appendix_when_enabled(client):
    c, redcap = client
    token = start(c, include_appendix=True)
    assert submit(c, token, build_response(appendix=True)).status_code == 201
    assert redcap.records["P0012"]["a8"] == "1"
    assert redcap.records["P0012"]["vfq_appendix_complete"] == "2"


def test_skip_q1_option(client):
    c, redcap = client
    token = start(c, skip_q1=True)
    assert submit(c, token, build_response(drop=("q01",))).status_code == 201
    assert "q01" not in redcap.records["P0012"]


def test_pdf_download_for_staff(client):
    c, _ = client
    submit(c, start(c), build_response())
    r = c.get("/api/records/P0012/pdf", headers={"X-Staff-Pin": PIN})
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF")
    assert r.headers["cache-control"] == "no-store"


# --- security: names and pseudonyms ---------------------------------------------------

@pytest.mark.parametrize("pid", ["Max Mustermann", "MUSTERMANN", "P12", "p0012", "P0012; DROP", ""])
def test_session_rejects_names_and_bad_codes(client, pid):
    c, _ = client
    r = c.post("/api/sessions", json={"pid": pid}, headers={"X-Staff-Pin": PIN})
    assert r.status_code == 422


def test_response_pid_must_match_session(client):
    c, redcap = client
    token = start(c, pid="P0012")
    r = submit(c, token, build_response(pid="P0099"))
    assert r.status_code == 422
    assert redcap.records == {}


# --- security: tokens and PIN -----------------------------------------------------

def test_submit_without_token_is_rejected(client):
    c, _ = client
    assert submit(c, "", build_response()).status_code == 401
    assert submit(c, "made-up-token", build_response()).status_code == 401


def test_token_works_only_once(client):
    c, _ = client
    token = start(c)
    assert submit(c, token, build_response()).status_code == 201
    assert submit(c, token, build_response()).status_code == 401


def test_invalid_submission_keeps_session_open(client):
    c, _ = client
    token = start(c)
    bad = build_response(answers={"q03": "9"})
    assert submit(c, token, bad).status_code == 422
    assert submit(c, token, build_response()).status_code == 201


def test_wrong_pin_rejected(client):
    c, _ = client
    r = c.post("/api/sessions", json={"pid": "P0012"}, headers={"X-Staff-Pin": "000000"})
    assert r.status_code == 401
    assert c.get("/api/records/P0012/pdf").status_code == 401


def test_staff_check(client):
    c, _ = client
    assert c.post("/api/staff/check", headers={"X-Staff-Pin": PIN}).status_code == 204
    assert c.post("/api/staff/check", headers={"X-Staff-Pin": "000000"}).status_code == 401
    assert c.post("/api/staff/check").status_code == 401


def test_staff_check_counts_towards_lockout():
    c, _ = make_client(max_pin_attempts=3)
    for _ in range(3):
        c.post("/api/staff/check", headers={"X-Staff-Pin": "111111"})
    assert c.post("/api/staff/check", headers={"X-Staff-Pin": PIN}).status_code == 429


def test_pin_lockout_after_repeated_failures():
    c, _ = make_client(max_pin_attempts=3)
    for _ in range(3):
        c.post("/api/sessions", json={"pid": "P0012"}, headers={"X-Staff-Pin": "111111"})
    r = c.post("/api/sessions", json={"pid": "P0012"}, headers={"X-Staff-Pin": PIN})
    assert r.status_code == 429  # even the right PIN is refused during lockout


def test_expired_session(client):
    c, _ = make_client(session_ttl_seconds=0)
    token = start(c)
    assert submit(c, token, build_response()).status_code == 401


# --- validation: forged or inconsistent answers ---------------------------------------

def test_rejects_answer_code_not_on_scale(client):
    c, _ = client
    r = submit(c, start(c), build_response(answers={"q15c": "5"}))  # 15c has only 1-4
    assert r.status_code == 422 and "q15c" in r.json()["detail"]


def test_rejects_unknown_item(client):
    c, _ = client
    body = build_response()
    body["item"].append({"linkId": "q99", "answer": [{"valueCoding": {"code": "1"}}]})
    assert submit(c, start(c), body).status_code == 422


def test_rejects_answer_for_hidden_branch(client):
    c, _ = client
    body = build_response(answers={"q15": "1"})
    body["item"].append({"linkId": "q15a", "answer": [{"valueCoding": {"code": "1"}}]})
    r = submit(c, start(c), body)
    assert r.status_code == 422 and "should not be shown" in r.json()["detail"]


def test_rejects_appendix_when_not_enabled(client):
    c, _ = client
    assert submit(c, start(c), build_response(appendix=True)).status_code == 422


def test_rejects_completed_with_missing_items(client):
    c, _ = client
    r = submit(c, start(c), build_response(drop=("q20",)))
    assert r.status_code == 422 and "q20" in r.json()["detail"]


def test_in_progress_may_have_gaps(client):
    c, redcap = client
    r = submit(c, start(c), build_response(drop=("q20",), status="in-progress"))
    assert r.status_code == 201
    assert redcap.records["P0012"]["vfq_questionnaire_complete"] == "1"


def test_rejects_other_questionnaire(client):
    c, _ = client
    body = build_response()
    body["questionnaire"] = "http://example.org/other|1"
    assert submit(c, start(c), body).status_code == 422


def test_rejects_duplicate_answers(client):
    c, _ = client
    body = build_response()
    body["item"].append({"linkId": "q03", "answer": [{"valueCoding": {"code": "1"}}]})
    assert submit(c, start(c), body).status_code == 422


def test_rejects_oversized_body(client):
    c, _ = client
    token = start(c)
    r = c.post("/api/responses", content=b"x" * (70 * 1024),
               headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    assert r.status_code == 413


# --- configuration ------------------------------------------------------------------

def test_settings_refuse_short_pin():
    with pytest.raises(ValueError):
        Settings(staff_pin="1234").validate()


def test_settings_refuse_real_mode_without_https_or_token():
    with pytest.raises(ValueError):
        Settings(staff_pin=PIN, redcap_mode="redcap", redcap_api_url="http://x/api/",
                 redcap_api_token="A" * 32).validate()
    with pytest.raises(ValueError):
        Settings(staff_pin=PIN, redcap_mode="redcap", redcap_api_url="https://x/api/",
                 redcap_api_token="").validate()


def test_no_api_docs_exposed(client):
    c, _ = client
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert c.get(path).status_code == 404

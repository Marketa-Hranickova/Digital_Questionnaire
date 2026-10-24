"""Tests for tools/fhir_to_redcap.py. Run with: python3 -m pytest tests/"""
import csv
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import fhir_to_redcap as conv  # noqa: E402


@pytest.fixture(scope="module")
def questionnaire():
    return json.loads((ROOT / "questionnaire.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def rows(questionnaire):
    return conv.convert(questionnaire)[0]


def by_name(rows):
    return {r["Variable / Field Name"]: r for r in rows}


def test_first_field_is_record_id(rows):
    assert rows[0]["Variable / Field Name"] == "record_id"


def test_all_35_questions_are_radio_fields(rows):
    radios = [r for r in rows if r["Field Type"] == "radio"]
    assert len(radios) == 35


def test_answer_counts_match_paper_form(rows):
    f = by_name(rows)
    expected = {"q01": 5, "q02": 6, "q05": 6, "q15": 2, "q15a": 2, "q15b": 3, "q15c": 4,
                "q16": 6, "q17": 5, "q25": 5, "a3": 6, "a8": 6}
    for name, n in expected.items():
        assert len(f[name]["Choices, Calculations, OR Slider Labels"].split(" | ")) == n, name


def test_branching_logic(rows):
    f = by_name(rows)
    assert f["q15a"]["Branching Logic (Show field only if...)"] == "[q15] = '2'"
    assert f["q15b"]["Branching Logic (Show field only if...)"] == "[q15a] = '2'"
    for name in ("q15c", "q16", "q16a"):
        assert f[name]["Branching Logic (Show field only if...)"] == "[q15] = '1'"
    assert f["q17"]["Branching Logic (Show field only if...)"] == ""


def test_appendix_is_separate_form_at_the_end(rows):
    forms = [r["Form Name"] for r in rows]
    first_appendix = forms.index(conv.APPENDIX_FORM)
    assert set(forms[first_appendix:]) == {conv.APPENDIX_FORM}
    assert by_name(rows)["a3"]["Form Name"] == conv.APPENDIX_FORM


def test_variable_and_form_names_are_valid(rows):
    for r in rows:
        assert conv.VAR_PATTERN.match(r["Variable / Field Name"])
        assert conv.FORM_PATTERN.match(r["Form Name"])


def test_display_items_become_descriptive(rows):
    f = by_name(rows)
    assert f["part2_intro"]["Field Type"] == "descriptive"


def test_html_and_plain_labels(questionnaire):
    html = by_name(conv.convert(questionnaire)[0])["q05"]["Field Label"]
    plain = by_name(conv.convert(questionnaire, use_html=False)[0])["q05"]["Field Label"]
    assert "<u>" in html and html.startswith("5. ")
    assert "<u>" not in plain


def test_paging_puts_header_on_every_field(questionnaire):
    paged = conv.convert(questionnaire, paging=True)[0]
    unpaged = conv.convert(questionnaire, paging=False)[0]
    count = lambda rs: sum(bool(r["Section Header"]) for r in rs)  # noqa: E731
    assert count(paged) > count(unpaged)


def test_modification_notes_go_to_annotation(rows):
    assert "Würden Sie sagen" in by_name(rows)["q05"]["Field Annotation"]


def test_closing_text_is_not_a_field(questionnaire, rows):
    _, closing = conv.convert(questionnaire)
    assert len(closing) == 1 and "Ende des Fragebogens" in closing[0]
    assert "outro" not in by_name(rows)


def test_rejects_branching_on_later_field():
    q = {"resourceType": "Questionnaire", "item": [
        {"linkId": "x1", "type": "choice", "text": "A",
         "enableWhen": [{"question": "x2", "operator": "=", "answerCoding": {"code": "1"}}],
         "answerOption": [{"valueCoding": {"code": "1", "display": "Ja"}}]},
        {"linkId": "x2", "type": "choice", "text": "B",
         "answerOption": [{"valueCoding": {"code": "1", "display": "Ja"}}]},
    ]}
    with pytest.raises(conv.ConversionError):
        conv.convert(q)


def test_rejects_pipe_in_answer_label():
    q = {"resourceType": "Questionnaire", "item": [
        {"linkId": "x1", "type": "choice", "text": "A",
         "answerOption": [{"valueCoding": {"code": "1", "display": "a | b"}}]}]}
    with pytest.raises(conv.ConversionError):
        conv.convert(q)


def test_cli_writes_readable_csv(tmp_path):
    out = tmp_path / "dd.csv"
    assert conv.main([str(ROOT / "questionnaire.json"), str(out)]) == 0
    with open(out, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == conv.HEADERS
        assert len(list(reader)) > 35

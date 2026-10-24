"""Server-side validation of a FHIR QuestionnaireResponse against questionnaire.json.

The browser is never trusted: everything the UI checks is checked again here, against the
same questionnaire definition the UI renders.
"""
import re


class ValidationError(Exception):
    pass


class QuestionnaireRules:
    def __init__(self, questionnaire):
        if questionnaire.get("resourceType") != "Questionnaire":
            raise ValueError("not a FHIR Questionnaire")
        self.url = questionnaire["url"]
        self.version = questionnaire.get("version", "")
        self.items = {}       # linkId -> choice item
        self.group_of = {}    # linkId -> top-level group linkId
        self._collect(questionnaire.get("item", []), None)

    def _collect(self, items, group):
        for it in items:
            if it["type"] == "group":
                self._collect(it.get("item", []), it["linkId"])
            elif it["type"] == "choice":
                self.items[it["linkId"]] = it
                self.group_of[it["linkId"]] = group

    def allowed_codes(self, link_id):
        return {o["valueCoding"]["code"] for o in self.items[link_id]["answerOption"]}

    def is_enabled(self, item, answers):
        conditions = item.get("enableWhen") or []
        if not conditions:
            return True
        results = [answers.get(c["question"]) == c["answerCoding"]["code"] for c in conditions]
        return all(results) if item.get("enableBehavior", "all") == "all" else any(results)

    def expected_items(self, answers, include_appendix, skip_q1):
        """Choice items the patient had to answer, given their answers and the staff options."""
        expected = []
        for link_id, item in self.items.items():
            if self.group_of[link_id] == "appendix" and not include_appendix:
                continue
            if link_id == "q01" and skip_q1:
                continue
            if self.is_enabled(item, answers):
                expected.append(link_id)
        return expected


def _flatten(items, out):
    for it in items or []:
        if "answer" in it:
            if not isinstance(it["answer"], list) or len(it["answer"]) != 1:
                raise ValidationError(f"item '{it.get('linkId')}' must have exactly one answer")
            coding = it["answer"][0].get("valueCoding") or {}
            code = coding.get("code")
            if not isinstance(code, str):
                raise ValidationError(f"item '{it.get('linkId')}' has no valueCoding.code")
            if it["linkId"] in out:
                raise ValidationError(f"item '{it['linkId']}' answered twice")
            out[it["linkId"]] = code
        _flatten(it.get("item"), out)
    return out


def validate_response(resp, rules, session_pid, pid_pattern, options):
    """Return {linkId: code} if the response is acceptable, else raise ValidationError."""
    if not isinstance(resp, dict) or resp.get("resourceType") != "QuestionnaireResponse":
        raise ValidationError("body must be a FHIR QuestionnaireResponse")

    expected_ref = f"{rules.url}|{rules.version}" if rules.version else rules.url
    if resp.get("questionnaire") not in (expected_ref, rules.url):
        raise ValidationError("response belongs to a different questionnaire or version")

    pid = (((resp.get("subject") or {}).get("identifier")) or {}).get("value")
    if not isinstance(pid, str) or not re.fullmatch(pid_pattern, pid):
        raise ValidationError("patient code missing or not in the allowed pseudonym format")
    if pid != session_pid:
        raise ValidationError("patient code does not match the session")

    answers = _flatten(resp.get("item"), {})

    for link_id, code in answers.items():
        if link_id not in rules.items:
            raise ValidationError(f"unknown item '{link_id}'")
        if code not in rules.allowed_codes(link_id):
            raise ValidationError(f"answer '{code}' is not allowed for '{link_id}'")

    include_appendix = bool(options.get("include_appendix"))
    skip_q1 = bool(options.get("skip_q1"))
    expected = set(rules.expected_items(answers, include_appendix, skip_q1))

    extra = set(answers) - expected
    if extra:
        raise ValidationError(f"answers for items that should not be shown: {sorted(extra)}")

    if resp.get("status") == "completed":
        missing = expected - set(answers)
        if missing:
            raise ValidationError(f"status is 'completed' but items are missing: {sorted(missing)}")
    elif resp.get("status") != "in-progress":
        raise ValidationError("status must be 'completed' or 'in-progress'")

    return answers

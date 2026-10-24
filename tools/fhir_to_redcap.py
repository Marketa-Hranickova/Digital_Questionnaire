#!/usr/bin/env python3
"""Convert a FHIR R4 Questionnaire (questionnaire.json) into a REDCap data dictionary (CSV).

The FHIR file stays the single source of truth; the CSV is generated and never edited by hand.

Usage:
    python3 tools/fhir_to_redcap.py questionnaire.json redcap/vfq25_data_dictionary.csv
    python3 tools/fhir_to_redcap.py questionnaire.json out.csv --no-html --no-paging

Mapping:
    choice item   -> radio field, choices "1, Label | 2, Label", required
    display item  -> descriptive field (intro texts)
    group         -> section header (repeated on every field by default, so that REDCap's
                     "one section per page" survey setting shows one question per screen)
    enableWhen    -> branching logic, e.g. [q15] = '1'
    appendix      -> separate instrument, so the clinic can switch it on or off
    modification notes (RAND licence) -> Field Annotation (not shown to patients)
"""
import argparse
import csv
import json
import re
import sys

XHTML_EXT = "http://hl7.org/fhir/StructureDefinition/rendering-xhtml"
NOTE_EXT = "http://example.org/4health/StructureDefinition/modification-note"

# Column headers of the REDCap data dictionary, in the order REDCap expects them
HEADERS = [
    "Variable / Field Name",
    "Form Name",
    "Section Header",
    "Field Type",
    "Field Label",
    "Choices, Calculations, OR Slider Labels",
    "Field Note",
    "Text Validation Type OR Show Slider Number",
    "Text Validation Min",
    "Text Validation Max",
    "Identifier?",
    "Branching Logic (Show field only if...)",
    "Required Field?",
    "Custom Alignment",
    "Question Number (surveys only)",
    "Matrix Group Name",
    "Matrix Ranking?",
    "Field Annotation",
]

MAIN_FORM = "vfq_questionnaire"
APPENDIX_FORM = "vfq_appendix"
APPENDIX_GROUP = "appendix"

VAR_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
FORM_PATTERN = re.compile(r"^[a-z][a-z_]*$")  # REDCap: lowercase letters and underscores
MAX_VAR_LEN = 26  # REDCap recommends short names; longer ones trigger a warning


class ConversionError(Exception):
    pass


def to_var(link_id):
    """FHIR linkId -> REDCap variable name (lowercase, underscores)."""
    name = link_id.lower().replace("-", "_").replace(".", "_")
    if not VAR_PATTERN.match(name):
        raise ConversionError(f"linkId '{link_id}' cannot become a valid REDCap variable ('{name}')")
    if len(name) > MAX_VAR_LEN:
        raise ConversionError(f"variable '{name}' is longer than {MAX_VAR_LEN} characters")
    return name


def extension(item, url):
    for ext in (item.get("_text") or {}).get("extension", []):
        if ext.get("url") == url:
            return ext.get("valueString")
    return None


def label(item, use_html):
    """Field label: keep <u>/<br> markup from the xhtml rendering when allowed."""
    xhtml = extension(item, XHTML_EXT) if use_html else None
    if xhtml:
        text = re.sub(r"^<div[^>]*>|</div>$", "", xhtml.strip())
        text = text.replace("<br/>", "<br>")
    else:
        text = item.get("text", "")
        text = text.replace("\n", " ").strip()
    prefix = item.get("prefix")
    return f"{prefix} {text}" if prefix else text


def choices(item):
    parts = []
    for opt in item.get("answerOption", []):
        coding = opt.get("valueCoding") or {}
        code, display = coding.get("code"), coding.get("display")
        if code is None or display is None:
            raise ConversionError(f"item '{item['linkId']}' has an answerOption without code/display")
        if not re.fullmatch(r"-?\d+", str(code)):
            raise ConversionError(f"item '{item['linkId']}': answer code '{code}' is not an integer")
        if "|" in display:
            raise ConversionError(f"item '{item['linkId']}': '|' is not allowed in answer labels")
        parts.append(f"{code}, {display}")
    if not parts:
        raise ConversionError(f"choice item '{item['linkId']}' has no answer options")
    return " | ".join(parts)


def branching(item):
    conditions = item.get("enableWhen") or []
    if not conditions:
        return ""
    behavior = item.get("enableBehavior", "all")
    joiner = " and " if behavior == "all" else " or "
    parts = []
    for c in conditions:
        if c.get("operator") != "=":
            raise ConversionError(f"item '{item['linkId']}': only operator '=' is supported")
        code = (c.get("answerCoding") or {}).get("code")
        if code is None:
            raise ConversionError(f"item '{item['linkId']}': enableWhen needs answerCoding.code")
        parts.append(f"[{to_var(c['question'])}] = '{code}'")
    return joiner.join(parts)


def row(**values):
    r = dict.fromkeys(HEADERS, "")
    r.update(values)
    return r


def convert(questionnaire, use_html=True, paging=True):
    """Return (rows, closing_texts).

    rows: data dictionary rows (dicts keyed by HEADERS).
    closing_texts: display texts placed after the appendix, to paste into REDCap's
    "Survey completion text" setting instead of becoming fields.
    """
    if questionnaire.get("resourceType") != "Questionnaire":
        raise ConversionError("input is not a FHIR Questionnaire")

    rows = [row(**{
        "Variable / Field Name": "record_id",
        "Form Name": MAIN_FORM,
        "Field Type": "text",
        "Field Label": "Patient code (pseudonym, never a name)",
        "Field Annotation": "Pseudonym such as P0012. The name-to-code key table stays at the clinic.",
    })]

    def walk(items, form, section, section_used):
        for it in items:
            kind = it.get("type")
            if kind == "group":
                child_form = APPENDIX_FORM if it["linkId"] == APPENDIX_GROUP else form
                walk(it.get("item", []), child_form, it.get("text", ""), [False])
                continue
            # Section header: on every field (paging) or only on the first field of a group
            header = ""
            if section and (paging or not section_used[0]):
                header = section
                section_used[0] = True
            annotation = extension(it, NOTE_EXT) or ""
            if kind == "choice":
                rows.append(row(**{
                    "Variable / Field Name": to_var(it["linkId"]),
                    "Form Name": form,
                    "Section Header": header,
                    "Field Type": "radio",
                    "Field Label": label(it, use_html),
                    "Choices, Calculations, OR Slider Labels": choices(it),
                    "Branching Logic (Show field only if...)": branching(it),
                    "Required Field?": "y" if it.get("required") else "",
                    "Custom Alignment": "LV",  # vertical list: large, easy tap targets
                    "Field Annotation": annotation,
                }))
            elif kind == "display":
                rows.append(row(**{
                    "Variable / Field Name": to_var(it["linkId"]),
                    "Form Name": form,
                    "Section Header": header,
                    "Field Type": "descriptive",
                    "Field Label": label(it, use_html),
                    "Branching Logic (Show field only if...)": branching(it),
                    "Field Annotation": annotation,
                }))
            else:
                raise ConversionError(f"item '{it.get('linkId')}': type '{kind}' is not supported")

    # Top-level display items after the appendix (the closing sentence) would split the main
    # form in two. REDCap shows such text via the survey setting "Survey completion text".
    top = questionnaire.get("item", [])
    split = next((i for i, it in enumerate(top) if it.get("linkId") == APPENDIX_GROUP), len(top))
    body = top[:split + 1]
    closing = [it for it in top[split + 1:] if it.get("type") == "display"]
    if len(closing) != len(top[split + 1:]):
        raise ConversionError("only display items may follow the appendix group")

    walk(body, MAIN_FORM, "", [False])
    validate(rows)
    return rows, [it.get("text", "") for it in closing]


def validate(rows):
    """Checks REDCap would otherwise reject (or silently mangle) on import."""
    names = [r["Variable / Field Name"] for r in rows]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise ConversionError(f"duplicate variable names: {sorted(dupes)}")
    known = set()
    seen_forms = []
    for r in rows:
        form = r["Form Name"]
        if not FORM_PATTERN.match(form):
            raise ConversionError(f"invalid form name '{form}'")
        if not seen_forms or seen_forms[-1] != form:
            if form in seen_forms:
                raise ConversionError(f"form '{form}' is not contiguous")
            seen_forms.append(form)
        # Branching may only refer to fields defined earlier
        for ref in re.findall(r"\[([a-z0-9_]+)\]", r["Branching Logic (Show field only if...)"]):
            if ref not in known:
                raise ConversionError(f"'{r['Variable / Field Name']}' branches on unknown or later field '{ref}'")
        known.add(r["Variable / Field Name"])


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("questionnaire", help="FHIR Questionnaire JSON file")
    p.add_argument("output", help="CSV file to write")
    p.add_argument("--no-html", action="store_true", help="plain-text labels (drop <u> underlines)")
    p.add_argument("--no-paging", action="store_true", help="section header only on the first field of each group")
    args = p.parse_args(argv)

    with open(args.questionnaire, encoding="utf-8") as f:
        questionnaire = json.load(f)
    try:
        rows, closing = convert(questionnaire, use_html=not args.no_html, paging=not args.no_paging)
    except ConversionError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    # utf-8-sig adds a BOM so Excel and REDCap read umlauts correctly
    with open(args.output, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=HEADERS, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(rows)

    radios = sum(r["Field Type"] == "radio" for r in rows)
    print(f"wrote {len(rows)} fields ({radios} questions) to {args.output}")
    for text in closing:
        print(f'\nPaste into REDCap > Survey Settings > "Survey completion text":\n{text}')
    return 0


if __name__ == "__main__":
    sys.exit(main())

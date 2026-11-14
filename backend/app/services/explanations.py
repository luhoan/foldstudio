"""Packaging for rule-based explanations, shared by the routes that return them."""
from app.services import explain_rules as rules


def strip_disclaimer(text: str) -> str:
    """Explanation text without the trailing disclaimer (it is returned once, separately)."""
    return text[: -len(rules.DISCLAIMER)].rstrip() if text.endswith(rules.DISCLAIMER) else text


def package(explanations: list) -> dict:
    """Per-rule explanations plus a flat view for simple clients.

    `summary` is the rule texts joined with the disclaimer removed from each,
    and `limitations` carries the disclaimer once. A client must show both; the
    summary on its own is deliberately incomplete.
    """
    items = [e.to_dict() for e in explanations]
    numbers: dict = {}
    for e in items:
        for ref in e["refs"]:
            numbers.setdefault(ref["name"], ref["value"])
    return {
        "explanations": items,
        "summary": " ".join(strip_disclaimer(e["text"]) for e in items),
        "numbers_used": numbers,
        "limitations": [rules.DISCLAIMER],
    }

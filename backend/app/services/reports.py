"""Reproducible report generation (Markdown + HTML). All dynamic text is escaped in HTML."""
import html
import json

from app.services import experiments as exp_svc
from app.services.structure_io import now_iso

KIND_LABEL = {"executed": "Executed", "imported": "Imported", "demo": "Demo"}
KIND_TEXT = {
    "executed": "Executed: produced by a job run by this team with the settings recorded below. Execution alone does not mean the output is correct or experimentally validated.",
    "imported": "Imported: real public or precomputed data that FoldStudio did not generate. Provenance below describes the source as recorded at import.",
    "demo": "Demo: illustrative data for demonstration only. Do not treat as a scientific result.",
}
GENERAL_LIMITATIONS = [
    "Model confidence scores (pLDDT, PAE, interface confidence) are the model's own estimates. They do not prove folding, binding, affinity, efficacy, safety or biological function.",
    "Predicted structures are not experimentally determined structures. Compare against experimental data where it exists.",
    "RMSD and TM-score depend on which residues were aligned; always check the reported selection.",
    "This report supports interpretation of computational evidence. It is not a diagnostic or clinical tool and does not replace experimental validation.",
]


def _structure_info(ctx, ref):
    from app.db import db

    if not isinstance(ref, str):
        return None
    with db(ctx) as c:
        r = c.execute("SELECT id,label,source,origin_id,format,sha256 FROM structures WHERE id=?", (ref,)).fetchone()
    return dict(r) if r else None


def build(ctx, ids: list[str]) -> dict:
    exps = [exp_svc.get(ctx, i) for i in ids]
    cmp_ = exp_svc.compare(ctx, ids) if len(ids) > 1 else None
    structs = {}
    for e in exps:
        for ref in e.get("inputs", []):
            info = _structure_info(ctx, ref)
            if info:
                structs[info["id"]] = info
    generated = now_iso()
    return {
        "generated_at": generated,
        "markdown": _markdown(exps, cmp_, structs, generated),
        "html": _html(exps, cmp_, structs, generated),
    }


def _j(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def _unavailable(e) -> list[tuple[str, str]]:
    """(metric, reason) pairs a bundle declared it could NOT measure.

    A report that lists only what was measured reads as if nothing was missing,
    so these are printed next to the metrics rather than left out.
    """
    block = e.get("metrics_unavailable")
    if not isinstance(block, dict):
        return []
    return [(str(k), str(v)) for k, v in block.items()]


def _definition(e, key) -> str:
    defs = e.get("metric_definitions")
    text = defs.get(key) if isinstance(defs, dict) else None
    return str(text) if isinstance(text, str) and text else ""


def _workflow(e) -> list[dict]:
    """Per-stage rows of a pipeline bundle, when it has them."""
    block = e.get("workflow")
    if not isinstance(block, list):
        return []
    rows = []
    for item in block:
        if not isinstance(item, dict) or not item.get("stage"):
            continue
        wall = item.get("wall_seconds")
        rows.append({
            "stage": str(item["stage"]),
            "status": str(item.get("status_label") or item.get("status") or "not recorded"),
            "wall": f"{wall:g} s" if isinstance(wall, (int, float)) and not isinstance(wall, bool) else "not recorded",
            "outputs": str(item.get("outputs")) if item.get("outputs") is not None else "not recorded",
            "preemptions": str(item.get("preemptions") or 0),
            "detail": str(item.get("error") or item.get("note") or ""),
        })
    return rows


def _md(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def _markdown(exps, cmp_, structs, generated):
    L = ["# FoldStudio analysis report", "", f"Generated: {generated}", f"Experiments: {', '.join(e['id'] for e in exps)}", ""]
    for e in exps:
        L += [f"## {e['id']} ({KIND_LABEL[e['kind']]}, status: {e['status']})", "", KIND_TEXT[e["kind"]], ""]
        L += [
            f"- Created: {e['created_at']}",
            f"- Model: {e['model_name']} {e.get('model_version') or '(version not recorded)'}",
            f"- Provenance source: {e['provenance'].get('source')}",
            f"- Provenance retrieved: {e['provenance'].get('retrieved_at') or 'not recorded'}",
            f"- Provenance URL: {e['provenance'].get('url') or 'not recorded'}",
            f"- Provenance notes: {e['provenance'].get('notes') or 'none'}",
            f"- Error: {e['error'] or 'none'}",
            "",
            "### Settings",
            "",
        ]
        L += [f"- {k}: {_j(v)}" for k, v in e["settings"].items()] or ["- none recorded"]
        L += ["", "### Inputs", ""]
        for ref in e["inputs"]:
            s = structs.get(ref) if isinstance(ref, str) else None
            L.append(f"- {ref}" + (f" ({s['source']}, origin {s['origin_id']}, sha256 {s['sha256']})" if s else ""))
        if not e["inputs"]:
            L.append("- none recorded")
        L += ["", "### Outputs", ""] + ([f"- {_j(o)}" for o in e["outputs"]] or ["- none recorded"])
        L += ["", "### Metrics", ""]
        for k, v in e["metrics"].items():
            d = _definition(e, k)
            L.append(f"- {k}: {_j(v)}" + (f" ({d})" if d else ""))
        if not e["metrics"]:
            L.append("- none recorded")
        missing = _unavailable(e)
        if missing:
            L += ["", "### Metrics not measured", "",
                  "The run recorded that it could not measure these, and why. They are not zero; they are absent.", ""]
            L += [f"- {k}: {reason}" for k, reason in missing]
        stages = _workflow(e)
        if stages:
            L += ["", "### Pipeline stages", "",
                  "| Stage | Status | Wall time | Outputs | Preemptions | Error / note |", "|---|---|---|---|---|---|"]
            L += [f"| {_md(r['stage'])} | {_md(r['status'])} | {_md(r['wall'])} | {_md(r['outputs'])} | "
                  f"{_md(r['preemptions'])} | {_md(r['detail'])} |" for r in stages]
        L.append("")
    if cmp_:
        L += ["## Comparison", "", "| Field | " + " | ".join(_md(i) for i in cmp_["ids"]) + " | Differs |", "|---|" + "---|" * (len(cmp_["ids"]) + 1)]
        for grp, title in (("fields", ""), ("settings", "settings."), ("metrics", "metrics.")):
            for r in cmp_[grp]:
                L.append(f"| {title}{_md(r['field'])} | " + " | ".join(_md(_j(r["values"][i])) for i in cmp_["ids"]) + f" | {'yes' if r['differs'] else 'no'} |")
        L += ["", cmp_["note"], ""]
    L += ["## Limitations", ""] + [f"- {t}" for t in GENERAL_LIMITATIONS]
    return "\n".join(L) + "\n"


def _html(exps, cmp_, structs, generated):
    e_ = html.escape

    def li(items):
        return "<ul>" + "".join(f"<li>{e_(str(i))}</li>" for i in items) + "</ul>"

    parts = [
        "<!doctype html><html lang='en'><head><meta charset='utf-8'><title>FoldStudio analysis report</title>",
        "<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.5}"
        "table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px;text-align:left;vertical-align:top}"
        ".badge{padding:2px 8px;border-radius:10px;background:#e0e7ff}code{font-size:.9em}</style></head><body>",
        "<h1>FoldStudio analysis report</h1>",
        f"<p>Generated: {e_(generated)}</p>",
    ]
    for e in exps:
        parts += [
            f"<h2>{e_(e['id'])} <span class='badge'>{e_(KIND_LABEL[e['kind']])}</span> <span class='badge'>{e_(e['status'])}</span></h2>",
            f"<p>{e_(KIND_TEXT[e['kind']])}</p>",
            li(
                [
                    f"Created: {e['created_at']}",
                    f"Model: {e['model_name']} {e.get('model_version') or '(version not recorded)'}",
                    f"Provenance source: {e['provenance'].get('source')}",
                    f"Provenance retrieved: {e['provenance'].get('retrieved_at') or 'not recorded'}",
                    f"Provenance URL: {e['provenance'].get('url') or 'not recorded'}",
                    f"Provenance notes: {e['provenance'].get('notes') or 'none'}",
                    f"Error: {e['error'] or 'none'}",
                ]
            ),
            "<h3>Settings</h3>",
            li([f"{k}: {_j(v)}" for k, v in e["settings"].items()] or ["none recorded"]),
            "<h3>Inputs</h3>",
            li(
                [
                    str(r) + (f" ({structs[r]['source']}, origin {structs[r]['origin_id']}, sha256 {structs[r]['sha256']})" if isinstance(r, str) and r in structs else "")
                    for r in e["inputs"]
                ]
                or ["none recorded"]
            ),
            "<h3>Outputs</h3>",
            li([_j(o) for o in e["outputs"]] or ["none recorded"]),
            "<h3>Metrics</h3>",
            li([f"{k}: {_j(v)}" + (f" ({_definition(e, k)})" if _definition(e, k) else "")
                for k, v in e["metrics"].items()] or ["none recorded"]),
        ]
        missing = _unavailable(e)
        if missing:
            parts += [
                "<h3>Metrics not measured</h3>",
                "<p>The run recorded that it could not measure these, and why. They are not zero; they are absent.</p>",
                li([f"{k}: {reason}" for k, reason in missing]),
            ]
        stages = _workflow(e)
        if stages:
            parts.append("<h3>Pipeline stages</h3><table><tr><th>Stage</th><th>Status</th><th>Wall time</th>"
                         "<th>Outputs</th><th>Preemptions</th><th>Error / note</th></tr>")
            for r in stages:
                parts.append("<tr>" + "".join(f"<td>{e_(r[k])}</td>" for k in
                                              ("stage", "status", "wall", "outputs", "preemptions", "detail")) + "</tr>")
            parts.append("</table>")
    if cmp_:
        parts.append("<h2>Comparison</h2><table><tr><th>Field</th>" + "".join(f"<th>{e_(i)}</th>" for i in cmp_["ids"]) + "<th>Differs</th></tr>")
        for grp, title in (("fields", ""), ("settings", "settings."), ("metrics", "metrics.")):
            for r in cmp_[grp]:
                parts.append(
                    f"<tr><td>{e_(title + r['field'])}</td>"
                    + "".join(f"<td>{e_(_j(r['values'][i]))}</td>" for i in cmp_["ids"])
                    + f"<td>{'yes' if r['differs'] else 'no'}</td></tr>"
                )
        parts.append(f"</table><p>{e_(cmp_['note'])}</p>")
    parts += ["<h2>Limitations</h2>", li(GENERAL_LIMITATIONS), "</body></html>"]
    return "".join(parts)

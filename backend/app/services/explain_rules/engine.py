"""Deterministic explanation rules for FoldStudio.

Every rule returns an ``Explanation``: human-readable text plus ``refs``, the
specific numbers the text was built from. Text is built only from
``rules_data.json`` templates. No rule reads a model, a network, or a clock.

Scientific-integrity constraint: no rule may claim binding, affinity,
efficacy, safety, or validation. The only place those words may appear is the
fixed ``DISCLAIMER`` sentence, which states that confidence is NOT evidence of
them. ``test_rules.py`` enforces this.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable, Sequence

_DATA = json.loads((Path(__file__).with_name("rules_data.json")).read_text())
DISCLAIMER: str = _DATA["disclaimer"]
PLDDT_BINS = _DATA["plddt_bins"]
T = _DATA["templates"]
SMALL_ALIGNMENT_ATOMS = 20


@dataclass
class Explanation:
    rule_id: str
    text: str
    refs: list[dict] = field(default_factory=list)  # [{"name","value","unit"}]

    def to_dict(self) -> dict:
        return asdict(self)


def _ref(name: str, value, unit: str | None = None) -> dict:
    return {"name": name, "value": value, "unit": unit}


def _finish(rule_id: str, body: str, refs: list[dict]) -> Explanation:
    return Explanation(rule_id, f"{body} {DISCLAIMER}", refs)


def plddt_bin(value: float) -> dict:
    if not 0 <= value <= 100:
        raise ValueError(f"pLDDT out of range 0-100: {value}")
    for b in PLDDT_BINS:  # ordered high -> low; lower bound inclusive
        if value >= b["min"]:
            return b
    return PLDDT_BINS[-1]


def explain_plddt_residue(value: float, chain: str, resnum: int) -> Explanation:
    b = plddt_bin(value)
    refs = [_ref("plddt", value), _ref("bin", b["id"]),
            _ref("chain", chain), _ref("resnum", resnum)]
    return _finish("plddt_residue", T_fmt(b["text"], value=value), refs)


def T_fmt(template: str, **kw) -> str:
    return template.format(**kw)


def explain_plddt_region(values: Sequence[float], chain: str, start: int, end: int) -> Explanation:
    if not values:
        raise ValueError("no pLDDT values")
    n = len(values)
    mean = sum(values) / n
    counts = {b["id"]: 0 for b in PLDDT_BINS}
    for v in values:
        counts[plddt_bin(v)["id"]] += 1
    bin_summary = "; ".join(
        f"{b['label']} {100 * counts[b['id']] / n:.0f}%" for b in PLDDT_BINS if counts[b["id"]]
    )
    refs = [_ref("mean_plddt", round(mean, 3)), _ref("n_residues", n),
           _ref("chain", chain), _ref("start", start), _ref("end", end)]
    refs += [_ref(f"fraction_{k}", round(c / n, 4)) for k, c in counts.items()]
    body = T["plddt_region"].format(start=start, end=end, chain=chain, n=n,
                                    mean=mean, bin_summary=bin_summary)
    return _finish("plddt_region", body, refs)


def _flat(m: Iterable[Iterable[float]]) -> list[float]:
    return [float(x) for row in m for x in row]


def explain_pae_region(pae: Sequence[Sequence[float]], chain: str, start: int, end: int) -> Explanation:
    vals = _flat(pae)
    if not vals:
        raise ValueError("empty PAE matrix")
    mean, mx = sum(vals) / len(vals), max(vals)
    refs = [_ref("mean_pae", round(mean, 3), "A"), _ref("max_pae", mx, "A"),
            _ref("n_pairs", len(vals)), _ref("chain", chain),
            _ref("start", start), _ref("end", end)]
    body = T["pae_region"].format(start=start, end=end, chain=chain,
                                  mean=mean, max=mx, n_pairs=len(vals))
    return _finish("pae_region", body, refs)


def explain_pae_interchain(pae_ab: Sequence[Sequence[float]], chain_a: str, chain_b: str) -> Explanation:
    vals = _flat(pae_ab)
    if not vals:
        raise ValueError("empty PAE block")
    mean = sum(vals) / len(vals)
    refs = [_ref("mean_interchain_pae", round(mean, 3), "A"), _ref("n_pairs", len(vals)),
            _ref("chain_a", chain_a), _ref("chain_b", chain_b)]
    body = T["pae_interchain"].format(chain_a=chain_a, chain_b=chain_b,
                                      mean=mean, n_pairs=len(vals))
    return _finish("pae_interchain", body, refs)


def explain_alignment(rmsd: float, tm_score: float | None, aligned_atoms: int,
                      aligned_residues: int, atom_type: str,
                      mobile: str, reference: str) -> Explanation:
    """Explain an /analysis/align result. Mirrors that response's fields."""
    parts = [T["rmsd"].format(rmsd=rmsd, aligned_atoms=aligned_atoms, atom_type=atom_type,
                              aligned_residues=aligned_residues, mobile=mobile, reference=reference)]
    refs = [_ref("rmsd", rmsd, "A"), _ref("aligned_atoms", aligned_atoms),
            _ref("aligned_residues", aligned_residues), _ref("atom_type", atom_type),
            _ref("mobile", mobile), _ref("reference", reference)]
    if aligned_atoms < SMALL_ALIGNMENT_ATOMS:
        parts.append(T["rmsd_small_n"].format(aligned_atoms=aligned_atoms))
    if tm_score is None:
        parts.append(T["tm_missing"])
        refs.append(_ref("tm_score", None))
    else:
        parts.append(T["tm_score"].format(tm=tm_score))
        refs.append(_ref("tm_score", tm_score))
    return _finish("alignment", " ".join(parts), refs)


def explain_experimental_vs_predicted(exp_id: str, pred_id: str, rmsd: float,
                                      tm_score: float | None, aligned_atoms: int,
                                      aligned_residues: int, atom_type: str,
                                      mean_plddt: float | None = None) -> Explanation:
    base = explain_alignment(rmsd, tm_score, aligned_atoms, aligned_residues,
                             atom_type, mobile=pred_id, reference=exp_id)
    body = T["exp_vs_pred"].format(exp_id=exp_id, pred_id=pred_id)
    refs = [_ref("experimental_id", exp_id), _ref("predicted_id", pred_id)] + base.refs
    if mean_plddt is not None:
        body += " " + T["exp_vs_pred_plddt"].format(mean=mean_plddt)
        refs.append(_ref("mean_plddt", mean_plddt))
    text = base.text.removesuffix(" " + DISCLAIMER) + " " + body
    return _finish("experimental_vs_predicted", text, refs)


def explain_interface(structure: str, chain_a: str, chain_b: str, n_contacts: int,
                      cutoff: float, iface_plddt: float | None = None,
                      iface_pae: float | None = None) -> Explanation:
    refs = [_ref("structure", structure), _ref("chain_a", chain_a), _ref("chain_b", chain_b),
            _ref("n_contacts", n_contacts), _ref("cutoff", cutoff, "A")]
    if iface_plddt is None or iface_pae is None:
        body = T["interface_experimental"].format(
            chain_a=chain_a, chain_b=chain_b, structure=structure,
            n_contacts=n_contacts, cutoff=cutoff)
    else:
        refs += [_ref("interface_mean_plddt", iface_plddt), _ref("interface_mean_pae", iface_pae, "A")]
        body = T["interface"].format(
            chain_a=chain_a, chain_b=chain_b, structure=structure, n_contacts=n_contacts,
            cutoff=cutoff, iface_plddt=iface_plddt, iface_pae=iface_pae)
    return _finish("interface", body, refs)

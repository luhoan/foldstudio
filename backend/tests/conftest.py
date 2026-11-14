"""Test helpers. IMPORTANT: coordinates here are SYNTHETIC geometry (a helix-like CA trace) used
only to unit-test math and parsing. They are not real proteins and are never shipped as app data."""
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import create_app

AA_CYCLE = ["ALA", "GLY", "LEU", "SER", "VAL", "LYS", "GLU", "THR", "ASP", "ILE"]


def helix(n=40, noise=0.0, seed=0):
    t = np.arange(n)
    xyz = np.stack([2.3 * np.cos(t * 100 * np.pi / 180), 2.3 * np.sin(t * 100 * np.pi / 180), 1.5 * t], axis=1)
    if noise:
        xyz = xyz + np.random.default_rng(seed).normal(0, noise, xyz.shape)
    return xyz


def rot(axis, deg):
    a = np.array(axis, float)
    a /= np.linalg.norm(a)
    th = np.radians(deg)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * (K @ K)


def make_pdb(coords, chain="A", resnames=None, bfactors=None, start=1, skip=()):
    lines = []
    serial = 1
    for i, (x, y, z) in enumerate(coords):
        if i in skip:
            continue
        rn = (resnames or AA_CYCLE * 100)[i]
        b = 50.0 if bfactors is None else bfactors[i]
        lines.append(
            f"ATOM  {serial:5d}  CA  {rn:>3s} {chain}{start + i:4d}    {x:8.3f}{y:8.3f}{z:8.3f}  1.00{b:6.2f}           C"
        )
        serial += 1
    lines.append("END")
    return "\n".join(lines) + "\n"


def upload(client, text, name="x.pdb", **form):
    return client.post("/api/structures/upload", files={"file": (name, text.encode(), "text/plain")}, data=form)


@pytest.fixture()
def client(tmp_path):
    app = create_app(tmp_path / "data")
    with TestClient(app) as c:
        c.ctx = app.state.ctx
        c.app_ = app
        yield c

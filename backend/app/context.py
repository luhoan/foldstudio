import os
from pathlib import Path


class Context:
    """Holds filesystem locations. Default data dir is <repo>/data (override: FOLDSTUDIO_DATA_DIR)."""

    def __init__(self, data_dir=None):
        repo_root = Path(__file__).resolve().parents[2]
        d = data_dir or os.environ.get("FOLDSTUDIO_DATA_DIR") or (repo_root / "data")
        self.data_dir = Path(d).resolve()
        self.structures_dir = self.data_dir / "structures"
        self.pae_dir = self.data_dir / "pae"
        self.experiments_dir = self.data_dir / "experiments"
        self.db_path = self.data_dir / "foldstudio.db"
        for p in (self.structures_dir, self.pae_dir, self.experiments_dir):
            p.mkdir(parents=True, exist_ok=True)

    def rel(self, path) -> str:
        return str(Path(path).resolve().relative_to(self.data_dir))

    def abs(self, rel: str) -> Path:
        p = (self.data_dir / rel).resolve()
        if self.data_dir not in p.parents:
            raise ValueError("path escapes data dir")
        return p

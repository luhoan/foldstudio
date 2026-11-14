"""Runner abstraction so GPU execution can be plugged in later without touching the API."""
from abc import ABC, abstractmethod

from app.errors import AppError


class Runner(ABC):
    name = "base"

    @abstractmethod
    def available(self) -> bool:
        """True only if this runner can really execute/resolve jobs right now."""

    @abstractmethod
    def submit(self, ctx, spec: dict) -> dict:
        """Return a job record: {job_id, runner, status, ...}."""

    def get(self, ctx, job_id: str) -> dict:
        raise AppError(404, f"not_found: job '{job_id}'")


class RunnerRegistry:
    def __init__(self):
        self._runners: dict[str, Runner] = {}

    def register(self, runner: Runner):
        if not runner.available():
            raise AppError(501, f"runner_unavailable: '{runner.name}' cannot run in this environment")
        self._runners[runner.name] = runner

    def names(self):
        return list(self._runners)

    def get(self, name: str | None) -> Runner:
        if not self._runners:
            raise AppError(501, "no_runner")
        if name is None:
            return next(iter(self._runners.values()))
        if name not in self._runners:
            raise AppError(400, f"unknown_runner: '{name}' (registered: {', '.join(self._runners)})")
        return self._runners[name]

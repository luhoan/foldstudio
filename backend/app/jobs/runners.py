import uuid

from app.errors import AppError
from app.jobs.base import Runner
from app.services import experiments as exp_svc


class PrecomputedRunner(Runner):
    """Resolves a job to an already-imported experiment. It never executes a model and never
    reports a run as 'executed': the job's result is flagged with the experiment's own kind."""

    name = "precomputed"

    def available(self) -> bool:
        return True

    def submit(self, ctx, spec: dict) -> dict:
        exp_id = spec.get("experiment_id")
        if not exp_id:
            raise AppError(400, "invalid_job: 'spec.experiment_id' is required for the precomputed runner")
        exp = exp_svc.get(ctx, exp_id)
        return {
            "job_id": f"job_{uuid.uuid4().hex[:10]}",
            "runner": self.name,
            "status": "completed",
            "experiment_id": exp["id"],
            "result_kind": exp["kind"],
            "note": "No computation was performed; this job points at an existing experiment record.",
        }


class LocalRunner(Runner):
    """Stub: run RFdiffusion/ProteinMPNN/prediction on this machine. Not implemented."""

    name = "local"

    def available(self) -> bool:
        return False

    def submit(self, ctx, spec: dict) -> dict:
        raise AppError(501, "runner_not_implemented: local execution is not implemented")


class RemoteRunner(Runner):
    """Stub: submit to a remote GPU service (e.g. Slurm cluster or cloud). Not implemented."""

    name = "remote"

    def available(self) -> bool:
        return False

    def submit(self, ctx, spec: dict) -> dict:
        raise AppError(501, "runner_not_implemented: remote execution is not implemented")

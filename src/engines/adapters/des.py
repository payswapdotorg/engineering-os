#!/usr/bin/env python3
"""Engineering OS — discrete-event simulation adapter (engine: SimPy, §5.3).

Protocol (house style, same as the quantity/tessellation adapters):
  argv[1]        absolute path to a JSON file holding an eos-des-scenario/1
                 document (contract §3.3 — the routes' zod is the primary
                 gate; this adapter DEFENDS ITSELF, mirroring the schema,
                 because stored bytes are not trusted)
  stdout (exit 0): {
    "engineKey":     "simpy",
    "engineVersion": <real simpy.__version__>,
    "adapterScript": "des.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "policy":        "fifo",
    "makespan":      <env.now when the last job finished, scenario time unit>,
    "resources": [{"id", "busy", "utilization"}, ...]   — INPUT order
    "jobs":      [{"id", "startAt", "endAt"}, ...]      — INPUT order
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated result.

Semantics (contract §5.3):
  - FIFO resources: simpy.Resource(env, capacity); jobs are processes created
    in INPUT order, so simultaneous requests queue FIFO by creation order.
  - tasks run SEQUENTIALLY per job, in array order.
  - arriveAt > 0 delays the job's FIRST request by an initial env.timeout.
  - per-job startAt = when the first task's resource is GRANTED; endAt = when
    the last task completes; per-resource busy = sum of durations actually
    served; utilization = busy / makespan.
  - fully deterministic by construction: no stochastic distributions this
    phase (contract §10); time values are emitted verbatim (ints stay ints).
"""

import hashlib
import json
import math
import os
import re
import sys

ENGINE_KEY = "simpy"
ADAPTER_NAME = "des.py"

ID_RE = re.compile(r"^[a-z0-9-]{1,32}$")


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def check_id(value, what: str) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise RuntimeError(f"{what} id must match ^[a-z0-9-]{{1,32}}$ (got {json.dumps(value)})")
    return value


def validate_scenario(doc) -> dict:
    """Mirror of contract §3.3 (defense-in-depth; the route zod is the primary gate)."""
    if not isinstance(doc, dict):
        raise RuntimeError("scenario document must be a JSON object")
    if doc.get("format") != "eos-des-scenario/1":
        raise RuntimeError(
            f"scenario document format must be \"eos-des-scenario/1\" (got {json.dumps(doc.get('format'))})"
        )
    name = doc.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 200):
        raise RuntimeError("scenario document name must be a string of 1..200 characters")
    time_unit = doc.get("timeUnit", "day")
    if time_unit not in ("hour", "day", "minute"):
        raise RuntimeError(f"scenario timeUnit must be \"hour\"|\"day\"|\"minute\" (got {json.dumps(time_unit)})")

    resources = doc.get("resources")
    if not isinstance(resources, list) or not (1 <= len(resources) <= 32):
        raise RuntimeError("scenario must carry 1..32 resources")
    resource_ids = set()
    for i, r in enumerate(resources):
        if not isinstance(r, dict):
            raise RuntimeError(f"resources[{i}] must be an object")
        rid = check_id(r.get("id"), f"resources[{i}]")
        if rid in resource_ids:
            raise RuntimeError(f'resource id "{rid}" is used more than once')
        resource_ids.add(rid)
        capacity = r.get("capacity", 1)
        if not isinstance(capacity, int) or isinstance(capacity, bool) or not (1 <= capacity <= 8):
            raise RuntimeError(f"resources[{i}].capacity must be an integer 1..8")

    jobs = doc.get("jobs")
    if not isinstance(jobs, list) or not (1 <= len(jobs) <= 256):
        raise RuntimeError("scenario must carry 1..256 jobs")
    job_ids = set()
    for i, j in enumerate(jobs):
        if not isinstance(j, dict):
            raise RuntimeError(f"jobs[{i}] must be an object")
        jid = check_id(j.get("id"), f"jobs[{i}]")
        if jid in job_ids:
            raise RuntimeError(f'job id "{jid}" is used more than once')
        job_ids.add(jid)
        arrive_at = j.get("arriveAt", 0)
        if not is_num(arrive_at) or arrive_at < 0:
            raise RuntimeError(f"jobs[{i}].arriveAt must be a number >= 0")
        tasks = j.get("tasks")
        if not isinstance(tasks, list) or not (1 <= len(tasks) <= 8):
            raise RuntimeError(f"jobs[{i}].tasks must be an array of 1..8 tasks")
        for k, t in enumerate(tasks):
            if not isinstance(t, dict):
                raise RuntimeError(f"jobs[{i}].tasks[{k}] must be an object")
            if t.get("resourceId") not in resource_ids:
                raise RuntimeError(
                    f'jobs[{i}].tasks[{k}] references unknown resource {json.dumps(t.get("resourceId"))}'
                )
            if not is_num(t.get("duration")) or t["duration"] <= 0:
                raise RuntimeError(f"jobs[{i}].tasks[{k}].duration must be a number > 0")

    return {"resources": resources, "jobs": jobs}


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: des.py <absolute-path-to-scenario-json> (exactly one argument required)")
    scenario_path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(scenario_path):
        fail(f"file not found: {scenario_path}")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import simpy
        except Exception as e:
            raise RuntimeError(f"simpy is not importable in this python ({e})")

        engine_version = getattr(simpy, "__version__", None) or "unknown"

        try:
            with open(scenario_path, "r", encoding="utf-8") as f:
                doc = json.loads(f.read())
        except Exception as e:
            raise RuntimeError(f"scenario file is not valid JSON: {e}")

        scen = validate_scenario(doc)

        env = simpy.Environment()
        resources = {}
        busy = {}
        for r in scen["resources"]:
            resources[r["id"]] = simpy.Resource(env, capacity=r.get("capacity", 1))
            busy[r["id"]] = 0

        records = {}

        def job_process(env, job):
            arrive_at = job.get("arriveAt", 0)
            if arrive_at > 0:
                yield env.timeout(arrive_at)
            start = None
            for t in job["tasks"]:
                res = resources[t["resourceId"]]
                with res.request() as req:
                    yield req
                    if start is None:
                        start = env.now
                    yield env.timeout(t["duration"])
                    busy[t["resourceId"]] += t["duration"]
            records[job["id"]] = {"startAt": start, "endAt": env.now}

        for job in scen["jobs"]:
            env.process(job_process(env, job))
        env.run()
        makespan = env.now

        if records and any(rec["startAt"] is None for rec in records.values()):
            raise RuntimeError("simulation produced a job with no served tasks — refusing to emit it")

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "policy": "fifo",
            "makespan": makespan,
            "resources": [
                {"id": r["id"], "busy": busy[r["id"]], "utilization": busy[r["id"]] / makespan}
                for r in scen["resources"]
            ],
            "jobs": [{"id": j["id"], **records[j["id"]]} for j in scen["jobs"]],
        }
    except RuntimeError as e:
        error = str(e)
    except Exception as e:  # unexpected: still an honest error envelope
        error = f"unexpected adapter failure: {type(e).__name__}: {e}"
    finally:
        try:
            sys.stdout.flush()
        except Exception:
            pass
        os.dup2(saved_fd, 1)
        os.close(saved_fd)

    if error is not None:
        fail(error)
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()

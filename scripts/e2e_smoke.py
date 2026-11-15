#!/usr/bin/env python3
"""Drive the running FoldStudio app in a real browser and check that every page works.

    python3 scripts/e2e_smoke.py                      # app at http://localhost:5173
    python3 scripts/e2e_smoke.py --url http://localhost:4173 --shots /tmp/shots

This is the one check the unit tests cannot make: the real 3D viewer (WebGL), against the real
backend, with whatever data is loaded. It is read-only except for two things it says it does:
it downloads a report (into a temporary directory) and it follows links inside the app.

It needs Playwright, which is NOT a dependency of the project:

    pip install playwright && playwright install chromium

With no Playwright installed it exits 2 and changes nothing. Exit 0 means every check that could
run passed; exit 1 means at least one failed. A check that cannot run on the data that is loaded
(no multi-chain structure, say) is reported as SKIP with the reason, never as a pass.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.parse

PAGES = [
    ("/", "Dashboard"),
    ("/explorer", "Protein Explorer"),
    ("/design", "Design Workspace"),
    ("/library", "Candidate Library"),
    ("/analysis", "Structural Analysis"),
    ("/comparison", "Comparison"),
    ("/history", "Experiment History"),
    ("/settings", "Settings"),
]

CHROME_CANDIDATES = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def add(self, status: str, name: str, detail: str = "") -> None:
        self.rows.append((status, name, detail))
        print(f"  {status:<4} {name}" + (f" — {detail}" if detail else ""), flush=True)

    def ok(self, name: str, detail: str = "") -> None:
        self.add("PASS", name, detail)

    def fail(self, name: str, detail: str = "") -> None:
        self.add("FAIL", name, detail)

    def skip(self, name: str, detail: str) -> None:
        self.add("SKIP", name, detail)

    def check(self, condition: bool, name: str, detail: str = "") -> bool:
        (self.ok if condition else self.fail)(name, detail)
        return bool(condition)

    @property
    def failed(self) -> int:
        return sum(1 for status, _, _ in self.rows if status == "FAIL")


class Watch:
    """Collects everything a browser reports going wrong on a page."""

    def __init__(self, page) -> None:
        self.problems: list[str] = []
        page.on("pageerror", lambda e: self.problems.append(f"page error: {str(e)[:300]}"))
        page.on("console", self._console)
        page.on("requestfailed", self._failed)
        page.on("response", self._response)

    def _console(self, message) -> None:
        if message.type != "error":
            return
        text = message.text
        # A failed request is reported once, by _response, with its URL.
        if "Failed to load resource" in text:
            return
        self.problems.append(f"console error: {text[:300]}")

    def _failed(self, request) -> None:
        failure = request.failure or ""
        # Navigating away cancels requests in flight; that is not a fault.
        if "ERR_ABORTED" in str(failure):
            return
        self.problems.append(f"request failed: {request.url} ({failure})")

    def _response(self, response) -> None:
        if response.status >= 400:
            self.problems.append(f"HTTP {response.status}: {response.url}")

    def take(self) -> list[str]:
        out, self.problems = self.problems, []
        return out


def canvas_is_drawn(page, selector: str) -> tuple[bool, str]:
    """True when a canvas shows more than one flat colour (a blank viewer is a single colour)."""
    canvas = page.locator(selector).first
    canvas.scroll_into_view_if_needed()
    box = canvas.bounding_box()
    if not box or box["width"] < 20 or box["height"] < 20:
        return False, "canvas has no size"
    png = canvas.screenshot()
    # The size of the compressed image is a cheap proxy for "something was drawn": a flat
    # rectangle compresses to a few hundred bytes, a rendered scene to many kilobytes.
    return len(png) > 6000, f"{len(png)} bytes of image for a {int(box['width'])}x{int(box['height'])} canvas"


def api(page, base: str, path: str):
    response = page.request.get(f"{base}/api{path}")
    if response.status != 200:
        raise RuntimeError(f"GET /api{path} answered {response.status}")
    return response.json()


def run(args) -> int:
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeout
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright is not installed, so the browser check was not run.\n"
              "  pip install playwright && playwright install chromium", file=sys.stderr)
        return 2

    base = args.url.rstrip("/")
    report = Report()
    shots = args.shots
    if shots:
        os.makedirs(shots, exist_ok=True)

    with sync_playwright() as pw:
        launch = dict(headless=not args.headed,
                      args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                            "--ignore-gpu-blocklist", "--no-sandbox"])
        chrome = args.chrome or next((c for c in CHROME_CANDIDATES if os.path.exists(c)), None)
        try:
            browser = pw.chromium.launch(**launch)
        except Exception:
            if not chrome:
                raise
            browser = pw.chromium.launch(executable_path=chrome, **launch)
        context = browser.new_context(viewport={"width": 1500, "height": 1100}, accept_downloads=True)
        page = context.new_page()
        watch = Watch(page)

        def shot(name: str) -> None:
            if shots:
                page.screenshot(path=os.path.join(shots, f"{name}.png"))

        def open_page(path: str, wait_ms: int = 1500) -> None:
            page.goto(f"{base}{path}", wait_until="networkidle")
            page.wait_for_timeout(wait_ms)

        def viewer_ready(timeout: int = 30000) -> bool:
            """The viewer toolbar is enabled once a structure has loaded."""
            try:
                page.wait_for_function(
                    """() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Reset view');
                               return !!b && !b.disabled }""", timeout=timeout)
                page.wait_for_timeout(1200)
                return True
            except PlaywrightTimeout:
                return False

        # ---- what is loaded -------------------------------------------------------------------
        print(f"FoldStudio at {base}")
        try:
            page.goto(base, wait_until="networkidle")
            structures = api(page, base, "/structures")
            experiments = api(page, base, "/experiments")
        except Exception as e:  # noqa: BLE001 - anything here means the app is not reachable
            report.fail("the app and its backend answer",
                        f"{str(e).splitlines()[0][:300]}. Start the backend (./run.sh in backend/) and the "
                        f"frontend (npm run dev in frontend/), or pass --url.")
            browser.close()
            return 1
        report.ok("the app and its backend answer", f"{len(structures)} structures, {len(experiments)} experiments")
        watch.take()

        with_coords = [s for s in structures if s["format"] != "fasta"]
        predicted = [s for s in with_coords if s["source"] == "predicted"]
        complexes = [s for s in with_coords if len(s["chains"]) > 1]
        runs = [e for e in experiments if e.get("workflow")]

        # ---- every page loads cleanly ---------------------------------------------------------
        print("Pages")
        for path, title in PAGES:
            open_page(path, 2500 if path in ("/explorer", "/library") else 1200)
            problems = watch.take()
            heading = page.locator("h1").first.inner_text() if page.locator("h1").count() else ""
            body = page.locator("body").inner_text()
            if heading != title:
                problems.append(f"heading is {heading!r}, expected {title!r}")
            if "failed to render" in body:
                problems.append("a panel crashed (its error boundary is showing)")
            if "No panel registered" in body:
                problems.append("a page has no panel registered")
            if "[object Object]" in body:
                problems.append('"[object Object]" is on screen')
            if "Backend not reachable" in body:
                problems.append("the shell says the backend is not reachable")
            report.check(not problems, f"{title} ({path})", "; ".join(problems)[:600])
            shot(f"page_{title.lower().replace(' ', '_')}")

        # ---- Protein Explorer -----------------------------------------------------------------
        print("Protein Explorer")
        if not with_coords:
            report.skip("3D viewer draws a structure", "no structure with coordinates is loaded")
        else:
            target = (predicted or with_coords)[0]
            open_page(f"/explorer?structure={urllib.parse.quote(target['id'])}", 500)
            if report.check(viewer_ready(), "3D viewer loads a structure", target["label"]):
                drawn, detail = canvas_is_drawn(page, '[data-panel-id="structure-explorer"] canvas')
                report.check(drawn, "3D viewer draws something", detail)
            shot("explorer")
            report.check(page.locator('select[aria-label="Structure"]').input_value() == f"library:{target['id']}",
                         "the structure a link names is the one shown")

            first_residue = page.locator('[data-panel-id="sequence"] button[aria-pressed]').first
            if first_residue.count() == 0:
                report.fail("sequence strip lists residues", "no residue buttons found")
            else:
                label = first_residue.get_attribute("aria-label") or ""
                first_residue.click()
                page.wait_for_timeout(1500)
                card = page.locator('[data-panel-id="structure-details"] section', has_text="Selected residue").first
                text = card.inner_text() if card.count() else ""
                name = " ".join(label.split(",")[0].split())  # e.g. "MET 1"
                report.check(name in " ".join(text.split()), "clicking a residue in the sequence selects it",
                             f"{label!r} -> sidebar shows {name!r}" if name in " ".join(text.split()) else f"sidebar says: {text[:160]!r}")
                report.check(first_residue.get_attribute("aria-pressed") == "true", "the selected residue is marked in the sequence")

            sidebar = page.locator('[data-panel-id="structure-details"]').inner_text()
            if target["source"] == "predicted":
                report.check("Mean pLDDT" in sidebar, "a predicted model shows its pLDDT summary")
            else:
                report.check("Not reported" in sidebar and "Mean pLDDT" not in sidebar,
                             "a structure that is not a predicted model shows no pLDDT")
            if target.get("has_pae"):
                pae = page.locator('[data-panel-id="pae"] canvas')
                ok = pae.count() == 1
                if ok:
                    drawn, detail = canvas_is_drawn(page, '[data-panel-id="pae"] canvas')
                    report.check(drawn, "PAE heatmap is drawn", detail)
                else:
                    report.fail("PAE heatmap is drawn", "the structure has PAE but no heatmap canvas is on the page")
            else:
                report.skip("PAE heatmap is drawn", f"{target['label']} has no PAE file")

            # A structure that is not predicted must not show confidence.
            other = next((s for s in with_coords if s["source"] != "predicted"), None)
            if other and other["id"] != target["id"]:
                open_page(f"/explorer?structure={urllib.parse.quote(other['id'])}", 500)
                viewer_ready()
                sidebar = page.locator('[data-panel-id="structure-details"]').inner_text()
                report.check("Not reported" in sidebar and "Mean pLDDT" not in sidebar,
                             "a structure that is not a predicted model shows no pLDDT", other["label"])
            problems = watch.take()
            report.check(not problems, "no errors while using the Explorer", "; ".join(problems)[:600])

        # ---- Candidate Library ----------------------------------------------------------------
        print("Candidate Library")
        if not complexes:
            report.skip("interfaces of a multi-chain structure", "no multi-chain structure is loaded")
        else:
            target = complexes[0]
            open_page(f"/library?structure={urllib.parse.quote(target['id'])}", 500)
            ready = viewer_ready()
            report.check(ready, "the complex is drawn in 3D", target["label"])
            highlight = page.get_by_role("button", name="Highlight chain", exact=False).first
            if highlight.count() == 0:
                body = page.locator('[data-panel-id="candidate-library"]').inner_text()
                if "No chains are in contact" in body:
                    report.skip("highlighting an interface", "the chains of this structure are not in contact at the default distance")
                else:
                    report.fail("interfaces are listed", body[:200])
            else:
                report.ok("interfaces are listed")
                highlight.click()
                page.wait_for_timeout(1500)
                report.check(page.get_by_role("button", name="Highlighted in 3D").count() == 1, "an interface side can be highlighted in 3D")
            shot("library")
            problems = watch.take()
            report.check(not problems, "no errors while using the Candidate Library", "; ".join(problems)[:600])

        # ---- Structural Analysis --------------------------------------------------------------
        print("Structural Analysis")
        pair = None
        for run_ in runs:
            by_origin = {s.get("origin_id"): s for s in structures}
            for design in run_.get("per_design") or []:
                file = (design.get("file") or "").split("/")[-1]
                backbone = (design.get("scrmsd") or {}).get("backbone")
                a, b = by_origin.get(f"{run_['id']}:{file}"), by_origin.get(f"{run_['id']}:{backbone}")
                if a and b:
                    pair = (a, b, "a design and the backbone it was made for")
                    break
            if pair:
                break
        if not pair and len(with_coords) >= 2:
            pair = (with_coords[0], with_coords[1], "the first two structures")
        if not pair:
            report.skip("aligning two structures", "fewer than two structures with coordinates are loaded")
        else:
            mobile, reference, what = pair
            open_page(f"/analysis?mobile={urllib.parse.quote(mobile['id'])}&reference={urllib.parse.quote(reference['id'])}", 1500)
            body = page.locator('[data-panel-id="alignment"]').inner_text()
            if "Result" in body and "RMSD" in body:
                report.ok("an alignment is computed and reported", f"{what}: {mobile['label']} onto {reference['label']}")
                report.check(viewer_ready(), "the superposition is drawn in 3D")
                page.wait_for_timeout(2500)
                notice = page.locator('[data-panel-id="alignment"]', has_text="Second structure:").count()
                report.check(notice == 0, "the second structure loads into the overlay")
                page.get_by_role("button", name="Side by side").click()
                page.wait_for_timeout(3500)
                notice = page.locator('[data-panel-id="alignment"]', has_text="Second structure:").count()
                report.check(notice == 0, "switching to side by side works")
                shot("analysis")
            elif "could not be computed" in body:
                # A legitimate answer for some pairs (too few matched residues, for one): the page
                # must show the backend's reason, and that is what is checked.
                reason = page.locator('[data-panel-id="alignment"] [role="alert"]').first.inner_text()
                report.check(len(reason.strip()) > 10, "an alignment the backend refuses is explained", reason[:200])
            else:
                report.fail("an alignment is computed and reported", body[:200])
            problems = [p for p in watch.take() if "/api/analysis/align" not in p]
            report.check(not problems, "no errors while using Structural Analysis", "; ".join(problems)[:600])

        # ---- Design Workspace -----------------------------------------------------------------
        print("Design Workspace")
        if not runs:
            report.skip("a pipeline run is shown stage by stage", "no experiment with a workflow block is loaded")
        else:
            run_ = runs[0]
            open_page(f"/design?run={urllib.parse.quote(run_['id'])}", 800)
            body = page.locator('[data-panel-id="design-workspace"]').inner_text()
            missing = [s["stage"] for s in run_["workflow"] if s["stage"] not in body]
            report.check(not missing, "every recorded stage is shown", f"{run_['id']}" + (f"; missing {missing}" if missing else ""))
            executed_here = run_["kind"] == "executed"
            claims_executed = any(s.get("status") == "executed" for s in run_["workflow"])
            if not executed_here:
                report.check("no model was run" in body or "was not run on this installation" in body,
                             "a record that was not run here says so")
            shown = page.locator('[data-panel-id="design-workspace"] ol [data-stage-status]').evaluate_all(
                "els => els.map(e => e.getAttribute('data-stage-status'))")
            recorded = [s.get("status") for s in run_["workflow"]]
            report.check(shown == recorded, "each stage shows exactly the status the pipeline recorded",
                         ", ".join(recorded) if shown == recorded else f"recorded {recorded}, shown {shown}")
            if not claims_executed:
                report.check("executed" not in shown, 'no stage is shown as "executed" unless the pipeline recorded it')
            shot("design")
            problems = watch.take()
            report.check(not problems, "no errors on the Design Workspace", "; ".join(problems)[:600])

        # ---- Experiment History and report export ---------------------------------------------
        print("Experiment History")
        if not experiments:
            report.skip("opening a record and exporting a report", "no experiment records are loaded")
        else:
            target = (runs or experiments)[0]
            open_page(f"/history?experiment={urllib.parse.quote(target['id'])}", 800)
            body = page.locator('[data-panel-id="experiment-history"]').inner_text()
            report.check("Provenance" in body, "a record opens to its details", target["id"])
            unavailable = target.get("metrics_unavailable") or {}
            if unavailable:
                report.check("Metrics not measured" in body and all(name in body for name in unavailable),
                             "metrics the run could not measure are listed as not measured")
            with tempfile.TemporaryDirectory() as tmp:
                try:
                    with page.expect_download(timeout=15000) as info:
                        page.get_by_role("button", name="Export report (HTML)").click()
                    path = os.path.join(tmp, "report.html")
                    info.value.save_as(path)
                    html = open(path, encoding="utf-8").read()
                    report.check(html.lstrip().lower().startswith("<!doctype html") and target["id"] in html,
                                 "the HTML report downloads and names the record", f"{len(html)} characters")
                    report.check("Not a clinical tool" in html or "not a clinical tool" in html.lower(),
                                 "the report carries the not-a-clinical-tool caveat")
                except PlaywrightTimeout:
                    report.fail("the HTML report downloads", "no download started within 15 s")
            shot("history")
            problems = watch.take()
            report.check(not problems, "no errors on Experiment History", "; ".join(problems)[:600])

        # ---- Comparison -----------------------------------------------------------------------
        print("Comparison")
        if len(experiments) < 2:
            report.skip("comparing two records", "fewer than two experiment records are loaded")
        else:
            ids = ",".join(e["id"] for e in experiments[:2])
            open_page(f"/comparison?ids={urllib.parse.quote(ids)}", 800)
            body = page.locator('[data-panel-id="experiment-comparison"]').inner_text()
            report.check("Side by side" in body, "two records are compared side by side", ids)
            shot("comparison")
            problems = watch.take()
            report.check(not problems, "no errors on Comparison", "; ".join(problems)[:600])

        # ---- Settings -------------------------------------------------------------------------
        print("Settings")
        open_page("/settings", 800)
        body = page.locator('[data-panel-id="settings"]').inner_text()
        report.check("reachable:" in body and "unreachable" not in body, "Settings reports the backend as reachable")
        health = api(page, base, "/health")
        errors = health.get("reindex", {}).get("errors", [])
        report.check(not errors, "the backend loaded every bundle in data/experiments",
                     "; ".join(f"{e.get('path')}: {e.get('error')}" for e in errors)[:600])
        shot("settings")
        problems = watch.take()
        report.check(not problems, "no errors on Settings", "; ".join(problems)[:600])

        browser.close()

    passed = sum(1 for s, _, _ in report.rows if s == "PASS")
    skipped = sum(1 for s, _, _ in report.rows if s == "SKIP")
    print(f"\n{passed} passed, {report.failed} failed, {skipped} skipped")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump([{"status": s, "check": n, "detail": d} for s, n, d in report.rows], fh, indent=2)
    return 1 if report.failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", default="http://localhost:5173", help="where the app is served (default: the Vite dev server)")
    parser.add_argument("--shots", help="directory to save a screenshot of each page into")
    parser.add_argument("--json", help="write the results to this file as JSON")
    parser.add_argument("--chrome", help="path to a Chrome/Chromium binary, if Playwright's own is not installed")
    parser.add_argument("--headed", action="store_true", help="show the browser window")
    return run(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())

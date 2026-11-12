"""Run the actual Pages build Bash offline; Python commands are local doubles."""

import os
from pathlib import Path
import shutil
import subprocess
import textwrap

import pytest

WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/pages.yml"
PREFIX = [
    "-m",
    "scripts.make_og_image",
    "--site",
    "../_site",
    "../live-sitemap.xml",
    "../live-noindex.txt",
    "--placements",
    "../placements.json",
    "--placements-report",
    "../placements-report.json",
]


def build_step():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    step = workflow.split("      - name: Build the site and its landing pages\n", 1)[1]
    step = step.split("\n      - name:", 1)[0]
    return step, textwrap.dedent(step.split("        run: |\n", 1)[1])


@pytest.fixture
def run_build(tmp_path):
    bash = shutil.which("bash")
    if not bash and Path("C:/Program Files/Git/bin/bash.exe").is_file():
        bash = "C:/Program Files/Git/bin/bash.exe"
    if not bash:
        pytest.skip("Bash is needed for the actual Pages build fixture")

    def run(mode=None, *, selected=False, failure=""):
        # Fresh, isolated root. Only the real workflow's relative _site/data removal runs.
        root = tmp_path / "isolated Pages fixture"
        (root / "docs/data").mkdir(parents=True)
        (root / "backend").mkdir()
        (root / "docs/index.html").write_text("unchanged dashboard", encoding="utf-8")
        (root / "docs/CNAME").write_text("example.invalid", encoding="utf-8")
        (root / "docs/data/index.json").write_text("primary index", encoding="utf-8")
        (root / "docs/data/first.json").write_text("primary first", encoding="utf-8")
        data = root / "docs/data"
        if selected:
            data = root / "selected public export/data"
            data.mkdir(parents=True)
            (data / "index.json").write_text("selected index", encoding="utf-8")
            (data / "first.json").write_text("selected first", encoding="utf-8")
        for name in ["live-content-dates.json", "live-sitemap.xml", "live-noindex.txt"]:
            (root / name).write_text(name, encoding="utf-8")
        (root / "placements.json").write_text('{"placements":[]}', encoding="utf-8")
        env = {
            **os.environ,
            "GITHUB_WORKSPACE": root.as_posix(),
            "INTERNSCOUT_PUBLIC_DATA": data.as_posix(),
            "FAIL_COMMAND": failure,
        }
        env.pop("EMPLOYER_POSTING_MODE", None)
        if mode is not None:
            env["EMPLOYER_POSTING_MODE"] = mode
        # Command/argument recording preserves boundaries, including spaces and absent flags.
        stub = r'''
python() {
  case "$2" in
    scripts.make_og_image)
      printf '%s\0' "$@" > "$GITHUB_WORKSPACE/publisher.args"
      printf '%s\0' "$INTERNSCOUT_PUBLIC_DATA" "$PYTHONPATH" > "$GITHUB_WORKSPACE/publisher.env"
      printf 'publisher\n' >> "$GITHUB_WORKSPACE/calls"
      [[ "$FAIL_COMMAND" != publisher ]] || return 70
      printf 'new sitemap' > "$GITHUB_WORKSPACE/_site/sitemap.xml" ;;
    internscout.site_links)
      printf '%s\0' "$@" > "$GITHUB_WORKSPACE/audit.args"
      printf 'audit\n' >> "$GITHUB_WORKSPACE/calls"
      [[ "$FAIL_COMMAND" != audit ]] || return 71 ;;
    *) return 90 ;;
  esac
}
'''
        result = subprocess.run(
            [bash, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", stub + build_step()[1]],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        return root, result

    return run


def nul_values(path):
    return path.read_bytes().decode("utf-8").split("\0")[:-1]


@pytest.mark.parametrize("selected", [False, True])
@pytest.mark.parametrize(
    ("mode", "flags"),
    [
        (None, []),
        ("", []),
        ("off", []),
        ("annotations", ["--employer-postings"]),
        ("capture", ["--employer-postings", "--employer-posting-capture"]),
    ],
)
def test_actual_build_exact_mode_arguments_and_same_export(run_build, selected, mode, flags):
    root, result = run_build(mode, selected=selected)
    assert result.returncode == 0, result.stdout + result.stderr
    assert nul_values(root / "publisher.args") == PREFIX + flags
    assert nul_values(root / "publisher.env") == [(root / "_site/data").as_posix(), "..:."]
    assert nul_values(root / "audit.args") == ["-m", "internscout.site_links", "../_site"]
    assert (root / "calls").read_text() == "publisher\naudit\n"
    source = "selected" if selected else "primary"
    for name in ["index", "first"]:
        assert (root / f"_site/data/{name}.json").read_text() == f"{source} {name}"
    assert (root / "_site/index.html").read_text() == "unchanged dashboard"
    assert (root / "_site/data/page-content-dates.json").read_text() == "live-content-dates.json"
    assert not (root / "_site/CNAME").exists()
    assert (root / "sitemaps/new.xml").read_text() == "new sitemap"
    assert (root / "sitemaps/old.xml").read_text() == "live-sitemap.xml"


@pytest.mark.parametrize(
    "mode",
    [
        "on",
        "true",
        "1",
        "OFF",
        "Capture",
        " capture",
        "capture ",
        "capture\n",
        "$(touch injected)",
        "off;touch injected",
    ],
)
def test_invalid_mode_fails_before_staging_without_evaluating_or_echoing(run_build, mode):
    root, result = run_build(mode)
    assert result.returncode != 0
    assert result.stdout == "::error::Invalid employer posting mode.\n"
    assert result.stderr == ""
    assert not (root / "_site").exists()
    assert not (root / "calls").exists()
    assert not (root / "injected").exists()


@pytest.mark.parametrize("failure", ["publisher", "audit"])
def test_failure_never_falls_back_or_continues_to_publication(run_build, failure):
    root, result = run_build("capture", failure=failure)
    assert result.returncode == (70 if failure == "publisher" else 71)
    assert (root / "calls").read_text() == (
        "publisher\n" if failure == "publisher" else "publisher\naudit\n"
    )
    assert not (root / "sitemaps").exists()


def test_variable_is_data_in_step_environment_only():
    step, script = build_step()
    assert "EMPLOYER_POSTING_MODE: ${{ vars.INTERNSCOUT_EMPLOYER_POSTING_MODE }}" in step
    assert "${{" not in script
    assert script.index('case "${EMPLOYER_POSTING_MODE:-}"') < script.index("cp -r docs _site")
    assert script.count("python -m scripts.make_og_image") == 1

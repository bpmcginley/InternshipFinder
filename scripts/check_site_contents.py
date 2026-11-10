"""Fail closed before Pages uploads any unexpected file or filesystem link.

The allow list contains full-match regular expressions over relative POSIX paths.
It describes public files, not arbitrary contents of a permitted directory.
"""

import argparse
from pathlib import Path
import re


DEFAULT_ALLOWLIST = Path(__file__).with_name("site-allowlist.txt")


def read_allowlist(path):
    return [
        re.compile(line)
        for raw in path.read_text(encoding="utf-8").splitlines()
        if (line := raw.strip()) and not line.startswith("#")
    ]


def audit(root, patterns):
    """Return the enumerated public files and problems without following links."""
    files, problems = [], []
    if root.is_symlink() or root.is_junction() or not root.is_dir():
        return files, ["site root must be a real directory"]
    pending = [root]
    directories = []
    while pending:
        folder = pending.pop()
        for path in sorted(folder.iterdir()):
            name = path.relative_to(root).as_posix()
            if path.is_symlink() or path.is_junction():
                problems.append(f"filesystem link: {name}")
            elif path.is_dir():
                directories.append(name)
                pending.append(path)
            elif path.is_file():
                files.append(name)
                if not any(pattern.fullmatch(name) for pattern in patterns):
                    problems.append(f"unexpected file: {name}")
            else:
                problems.append(f"unsupported filesystem entry: {name}")
    # Empty/unexpected directories should not quietly become future publication roots.
    for directory in directories:
        if not any(name.startswith(directory + "/") for name in files):
            problems.append(f"empty directory: {directory}")
    if not files:
        problems.append("site contains no files")
    return sorted(files), sorted(problems)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=Path)
    parser.add_argument("--allowlist", type=Path, default=DEFAULT_ALLOWLIST)
    parser.add_argument("--list", action="store_true", help="list every checked file")
    args = parser.parse_args(argv)
    try:
        files, problems = audit(args.site, read_allowlist(args.allowlist))
    except (OSError, re.error) as error:
        # Do not print exception text, which can contain filesystem or input details.
        print(f"Site contents check failed: {type(error).__name__}")
        return 1
    if args.list:
        print("\n".join(files))
    for problem in problems:
        print(problem)
    print(f"Site contents: {len(files)} files checked; {len(problems)} problems")
    return int(bool(problems))


if __name__ == "__main__":
    raise SystemExit(main())

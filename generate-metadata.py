import json
import os
import shutil
import subprocess
from typing import List, Tuple

x = open("meta-data.json", "w")

projects: List[Tuple[str, int]] = [
    ("Express", 27),
    ("Shields", 4),
    ("Bower", 3),
    ("Hexo", 12),
    ("Karma", 22),
    ("Hessian.js", 9),
    ("Eslint", 333),
    ("Node-redis", 7),
    ("Pencilblue", 7),
    ("Mongoose", 29),
]


result = []
id = 0
for name, bug_count in projects:
    os.makedirs(name, exist_ok=True)
    for bug in range(1, bug_count):
        os.makedirs(os.path.join(name, f"{name}-{bug}"),exist_ok=True)
        for script in ["build_subject","config_subject","setup_subject","test_subject"]:
            shutil.copy(script,os.path.join(name, f"{name}-{bug}",script))
        id += 1
        proc = subprocess.Popen(
            ["python3 main.py -p {} -i {}".format(name, bug)],
            stdout=subprocess.PIPE,
            shell=True,
        )

        (out, err) = proc.communicate()
        data = out.decode("utf-8")
        lines = data.split("\n")
        fix_commit = "N/A"
        bug_commit = "N/A"
        github_url = "N/A"
        for i, line in enumerate(lines):
            if line.startswith("Revision id"):
                fix_commit = lines[i + 1].strip()
            if line.startswith("Buggy id"):
                bug_commit = lines[i + 1].strip()
            if line.startswith("Github URL"):
                github_url = line.split(":")[1].strip()
        print(data)
        result.append(
            {
                "id": id,
                "subject": name,
                "bug_id": f"{name}-{bug}",
                "test_timeout": 5,
                "language": "python",
                "build_script": "build_subject",
                "config_script": "config_subject",
                "clean_script": "clean_subject",
                "test_script": "test_subject",
                "passing_test_identifiers": [],
                "count_pos": 0,
                "failing_test_identifiers": [],
                "count_neg": 0,
                "bug_commit": bug_commit,
                "fix_commit": fix_commit,
                "line_numbers": [],
                "dependencies": [],
            }
        )
        # input()

x.write(json.dumps(result, indent=4))
x.close()

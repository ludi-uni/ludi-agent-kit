# Code investigation and fix

Reproduce or locate the reported behavior before editing. Read the nearest
repository instructions, identify the responsible path, and distinguish observed
facts from assumptions. Search narrowly for the relevant symbol, input, caller,
and existing tests or checks.

State the smallest behavior change that satisfies the request. Edit only the
necessary files and preserve user changes. Add or update a meaningful focused
regression test when practical for a behavior change; do not add a test that merely
repeats implementation details.

Run the repository’s focused required check and any directly affected test. If a
check cannot run, report the exact blocker and other evidence. Finish when the
requested behavior is demonstrated, unrelated work remains intact, and remaining
limits are clear.

#!/usr/bin/env bash
# bezenti-verify: one part of a branch's receipt (see bezenti/README.md, «Verificación de ramas en CI»).
# Each part appends receipt lines (PASS/FAIL <kind> <target> ...) to $RESULTS and failure excerpts to
# $DETAILS, and exits 1 when anything failed. Run from the repository root.
#   bezenti-verify.sh lint
#   bezenti-verify.sh typecheck <package-dir>...
#   bezenti-verify.sh test <package-dir> <test-file>...       (paths from the repository root)
#   bezenti-verify.sh verdict <results-dir> <receipt-file>    (expects <results-dir>/expected.txt)
set -uo pipefail
mode=$1
shift
RESULTS=${RESULTS:-$RUNNER_TEMP/results.txt}
DETAILS=${DETAILS:-$RUNNER_TEMP/details.md}
LOGS=$RUNNER_TEMP/logs
mkdir -p "$LOGS"
touch "$RESULTS" "$DETAILS"
failed=0

say() {
  echo "$1" | tee -a "$RESULTS"
  case $1 in FAIL*) failed=1 ;; esac
}

# A failure's first lines, for the verdict's summary; the whole log stays in the job's output.
detail() {
  {
    echo "<details><summary>$1</summary>"
    echo
    echo '```text'
    sed 's/\x1b\[[0-9;]*m//g' | head -n "${2:-60}"
    echo '```'
    echo "</details>"
    echo
  } >>"$DETAILS"
}

show_log() {
  echo "::group::$1"
  cat "$2"
  echo "::endgroup::"
}

case $mode in
lint)
  log=$LOGS/lint.log
  if timeout 900 vp lint >"$log" 2>&1; then
    say "PASS lint ."
  else
    say "FAIL lint ."
    { grep -E '^::error|error' "$log" | grep -v '^::warning'; tail -n 2 "$log"; } | detail "lint ." 80
  fi
  show_log "vp lint" "$log"
  ;;

typecheck)
  for dir in "$@"; do
    log=$LOGS/typecheck-${dir//\//_}.log
    (cd "$dir" && timeout 900 vp exec effect-tsgo tsrs --noEmit) >"$log" 2>&1
    rc=$?
    # Known error already on the production base (2026-11-17): ThreadTabStrip.browser.test.tsx:134
    # (written `file(134,52)` when the output is not a terminal).
    errors=$(grep 'error TS' "$log" | grep -vE 'ThreadTabStrip\.browser\.test\.tsx(:134:|\(134,)')
    if [ -n "$errors" ]; then
      say "FAIL typecheck $dir ($(echo "$errors" | wc -l) errors)"
      echo "$errors" | detail "typecheck $dir"
    # effect-tsgo exits 2 on warnings alone; only a run with no TS diagnostics at all did not check.
    elif [ "$rc" != 0 ] && ! grep -qE '(error|warning|suggestion) TS[0-9]+' "$log"; then
      say "FAIL typecheck $dir (exit $rc without running)"
      tail -n 40 "$log" | detail "typecheck $dir"
    else
      say "PASS typecheck $dir"
    fi
    show_log "typecheck $dir (exit $rc)" "$log"
  done
  ;;

test)
  pkg=$1
  shift
  id=${pkg//\//_}-$$
  log=$LOGS/test-$id.log
  json=$LOGS/test-$id.json
  # The package's own `vp test run` flags (its config, projects), without --passWithNoTests:
  # a selected file that runs nothing is a failure.
  mapfile -t flags < <(node -e '
    const script = require(`./${process.argv[1]}/package.json`).scripts?.test ?? "";
    const args = script.replace(/^.*?vp test run\s*/, "").split(/\s+/).filter(Boolean);
    for (const arg of args) if (arg !== "--passWithNoTests") console.log(arg);
  ' "$pkg")
  rels=()
  for file in "$@"; do rels+=("${file#"$pkg"/}"); done
  extra=()
  # Fails on Linux runners with or without our changes: the test's SSH server listens on 127.0.0.1 and
  # "localhost" resolves to ::1 first (ECONNREFUSED). bezenti.yml skips it the same way.
  if [ "$pkg" = apps/server ]; then extra=(-t '^(?!.*refuses a second run to the same machine)'); fi
  (cd "$pkg" && timeout 1500 vp test run "${flags[@]}" "${extra[@]}" --reporter=default \
    --reporter=json --outputFile.json="$json" "${rels[@]}") >"$log" 2>&1
  rc=$?
  show_log "vp test run ($pkg, exit $rc)" "$log"
  node - "$json" "$rc" "$RESULTS" "$DETAILS" "$@" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [json, rc, resultsFile, detailsFile, ...files] = process.argv.slice(2);
let report = null;
try {
  report = JSON.parse(fs.readFileSync(json, "utf8"));
} catch {}
const byFile = new Map(
  (report?.testResults ?? []).map((result) => [path.relative(process.cwd(), result.name), result]),
);
const strip = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");
const lines = [];
const details = [];
for (const file of files) {
  const result = byFile.get(file);
  if (!result) {
    lines.push(`FAIL test ${file} (not run)`);
    continue;
  }
  const tests = result.assertionResults ?? [];
  const count = (status) => tests.filter((test) => test.status === status).length;
  const failures = tests.filter((test) => test.status === "failed");
  if (result.status === "passed" && failures.length === 0) {
    const skipped = count("skipped") + count("pending") + count("todo");
    lines.push(`PASS test ${file} (Tests ${count("passed")} passed${skipped ? `, ${skipped} skipped` : ""})`);
    continue;
  }
  lines.push(
    failures.length > 0
      ? `FAIL test ${file} (${failures.length} failed, ${count("passed")} passed)`
      : `FAIL test ${file} (the file failed to run)`,
  );
  const text = [
    result.message ? strip(result.message) : "",
    ...failures.map((test) => `✗ ${test.fullName}\n${strip(test.failureMessages?.join("\n") ?? "")}`),
  ]
    .filter(Boolean)
    .join("\n\n")
    .split("\n")
    .filter((line) => !line.includes("/node_modules/"))
    .slice(0, 80)
    .join("\n");
  details.push(`<details><summary>test ${file}</summary>\n\n\`\`\`text\n${text}\n\`\`\`\n</details>\n`);
}
// Vitest can fail outside every file (an unhandled error, a crashed worker).
if (rc !== "0" && !lines.some((line) => line.startsWith("FAIL"))) {
  lines.push(`FAIL test-run ${path.dirname(files[0] ?? ".")} (vitest exited ${rc} with every file passing)`);
}
fs.appendFileSync(resultsFile, lines.map((line) => `${line}\n`).join(""));
fs.appendFileSync(detailsFile, details.join("\n"));
console.log(lines.join("\n"));
EOF
  if grep -q '^FAIL' "$RESULTS"; then failed=1; fi
  if grep -q '^FAIL test-run' "$RESULTS"; then
    grep -iE 'error|unhandled' "$log" | head -n 40 | detail "vitest run in $pkg"
  fi
  ;;

verdict)
  dir=$1
  receipt=$2
  all=$(cat "$dir"/results-*.txt 2>/dev/null | sort -u)
  # Every planned item must have a line: a job that died before checking it did not pass it.
  reported=$(echo "$all" | awk '{ print $2 " " $3 }')
  if [ -f "$dir/expected.txt" ]; then
    missing=$(while read -r item; do
      [ -n "$item" ] || continue
      echo "$reported" | grep -qxF -- "$item" || echo "FAIL $item (no result: its job did not finish)"
    done <"$dir/expected.txt")
  else
    missing="FAIL plan . (the plan job did not finish)"
  fi
  touch "$dir/changed.txt"
  lines=$(printf '%s\n%s\n' "$all" "$missing" | grep -E '^(PASS|FAIL)' | sort -u)
  if [ -z "$lines" ] || echo "$lines" | grep -q '^FAIL'; then result=RED; else result=GREEN; fi
  {
    echo "receipt $BRANCH"
    echo "checkout ${HEAD_SHA:0:10} ($BRANCH)"
    echo "base ${BASE_SHA:0:10} ($BASE_HOW)"
    echo "run $RUN_URL"
    echo "date $(date -Is)"
    echo "changed files: $(wc -l <"$dir/changed.txt")"
    [ -n "$lines" ] && echo "$lines"
    echo "RESULT $result"
  } >"$receipt"
  cat "$receipt"
  {
    echo "## bezenti-verify: $result"
    echo
    echo '```text'
    cat "$receipt"
    echo '```'
    echo
    cat "$dir"/details-*.md 2>/dev/null
  } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  cat "$dir"/details-*.md >"${receipt%.txt}-details.md" 2>/dev/null
  [ "$result" = GREEN ] || failed=1
  ;;

*)
  echo "unknown mode: $mode" >&2
  exit 2
  ;;
esac

exit "$failed"

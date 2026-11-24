// The local receipt's selection from a branch's diff (bezenti/README.md, «Verificación de ramas en CI»):
// changed tests, tests beside each changed source (foo.ts -> foo.test.ts, foo.*.test.ts), door sweeps
// when apps/server changed; typecheck of owners and dependents (ci-changes.cjs); lint unless only Markdown.
// Usage: BASE=<sha> node .github/scripts/bezenti-verify-plan.cjs <out-dir>   (prints GITHUB_OUTPUT lines)
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { decide, readWorkspace } = require("./ci-changes.cjs");

const root = path.resolve(__dirname, "../..");

// Workflows, deploy files, notes and Markdown anywhere typecheck nothing (ci-changes.cjs would run
// every package for a path it does not know, such as .scratch/ notes).
const NO_PACKAGE = [/^\.github\//, /^bezenti\//, /^\.scratch\//, /\.md$/];

// The door sweeps catch a new door or reader that the diff's own tests don't.
const DOOR_SWEEPS = [
  "apps/server/src/auth/DoorRules.test.ts",
  "apps/server/src/auth/RpcAuthorization.test.ts",
  "apps/server/src/vaults/MaskedPaths.test.ts",
  "apps/server/src/environments/HubWithEnvironments.environmentDoors.test.ts",
];
const OPTIONAL_DOOR_SWEEPS = [
  "apps/server/src/audit/AuditLog.test.ts",
  "apps/server/src/auth/AuditLog.test.ts",
];

// Typechecks that take a runner each; the rest share runners in groups.
const HEAVY_TYPECHECK = new Set(["apps/server", "apps/web", "apps/mobile", "apps/desktop"]);
const TYPECHECK_GROUP = 6;

// Shards: estimated seconds per file and the most one shard should hold.
const SHARD_SECONDS = 60;
const MAX_SHARDS_PER_GROUP = 6;
const serverWeights = JSON.parse(
  fs.readFileSync(path.join(root, "apps/server/src/testUtils/shardWeights.json"), "utf8"),
);

const exists = (file) => fs.existsSync(path.join(root, file));
const isTest = (file) => /\.test\.tsx?$/.test(file);

function changedFiles(base) {
  return execFileSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
}

function selectTests(changed) {
  const tests = new Set(changed.filter((file) => isTest(file) && exists(file)));
  for (const file of changed) {
    if (!/\.tsx?$/.test(file) || isTest(file)) continue;
    const stem = file.replace(/\.[^./]*$/, "");
    const dir = path.posix.dirname(stem);
    const name = path.posix.basename(stem);
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const entry of fs.readdirSync(path.join(root, dir))) {
      if (entry.startsWith(`${name}.`) && isTest(entry)) tests.add(`${dir}/${entry}`);
    }
  }
  if (changed.some((file) => file.startsWith("apps/server/"))) {
    for (const file of DOOR_SWEEPS) tests.add(file);
    for (const file of OPTIONAL_DOOR_SWEEPS) if (exists(file)) tests.add(file);
  }
  return [...tests].sort();
}

function ownerDir(file, packages) {
  return packages
    .filter((pkg) => file.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0]?.dir;
}

function testSeconds(pkgDir, rel, kind) {
  if (kind === "browser") return 4;
  if (pkgDir === "apps/server") return (serverWeights[rel] ?? 2) + 1;
  return 1;
}

// Longest file first onto the lightest shard, as apps/server's WeightedShardSequencer does.
function planShards(tests, packages) {
  const groups = new Map();
  const unowned = [];
  for (const file of tests) {
    const pkgDir = ownerDir(file, packages);
    if (!pkgDir) {
      unowned.push(file);
      continue;
    }
    const rel = file.slice(pkgDir.length + 1);
    const kind = /\.browser\.test\.tsx?$/.test(file) ? "browser" : "node";
    const key = `${pkgDir} ${kind}`;
    if (!groups.has(key)) groups.set(key, { pkgDir, kind, files: [] });
    groups.get(key).files.push({ file, seconds: testSeconds(pkgDir, rel, kind) });
  }

  const shards = [];
  for (const { pkgDir, kind, files } of groups.values()) {
    const total = files.reduce((sum, file) => sum + file.seconds, 0);
    const count = Math.min(MAX_SHARDS_PER_GROUP, files.length, Math.ceil(total / SHARD_SECONDS));
    const loads = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
    for (const file of files.toSorted((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1))) {
      const lightest = loads.reduce((min, load) => (load.seconds < min.seconds ? load : min));
      lightest.seconds += file.seconds;
      lightest.files.push(file.file);
    }
    loads.forEach((load, index) => {
      const source = load.files.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
      shards.push({
        id: `${pkgDir.replaceAll("/", "_")}-${kind}-${index + 1}`,
        pkg: pkgDir,
        kind,
        files: load.files.toSorted().join(" "),
        seconds: Math.round(load.seconds),
        chromium: kind === "browser" || source.some((text) => /playwright/i.test(text)),
        electron: pkgDir === "apps/desktop",
      });
    });
  }
  return { shards, unowned };
}

function planTypecheck(changed, packages) {
  const files = changed.filter((file) => !NO_PACKAGE.some((pattern) => pattern.test(file)));
  if (files.length === 0) return [];
  const { affected } = decide(files, packages, false);
  const dirs = packages
    .filter((pkg) => affected.includes(pkg.name))
    .map((pkg) => pkg.dir)
    .sort();
  const heavy = dirs.filter((dir) => HEAVY_TYPECHECK.has(dir));
  const light = dirs.filter((dir) => !HEAVY_TYPECHECK.has(dir));
  const groups = heavy.map((dir) => [dir]);
  const lightGroups = Math.ceil(light.length / TYPECHECK_GROUP);
  for (let index = 0; index < lightGroups; index++) {
    groups.push(light.filter((_, position) => position % lightGroups === index));
  }
  return groups.map((group, index) => ({
    id: group.length === 1 ? group[0].replaceAll("/", "_") : `group-${index + 1}`,
    label: group.length === 1 ? group[0] : `${group.length} packages`,
    dirs: group.join(" "),
  }));
}

function main() {
  const outDir = process.argv[2];
  const base = process.env.BASE;
  if (!outDir || !base) throw new Error("usage: BASE=<sha> bezenti-verify-plan.cjs <out-dir>");
  const packages = readWorkspace();
  const changed = changedFiles(base);
  const lint = changed.some((file) => !file.endsWith(".md"));
  const typecheck = planTypecheck(changed, packages);
  const { shards, unowned } = planShards(selectTests(changed), packages);

  const expected = [
    ...(lint ? ["lint ."] : []),
    ...typecheck.flatMap((group) => group.dirs.split(" ").map((dir) => `typecheck ${dir}`)),
    ...shards.flatMap((shard) => shard.files.split(" ").map((file) => `test ${file}`)),
  ];
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "expected.txt"), expected.map((item) => `${item}\n`).join(""));
  // A test outside every workspace package cannot run: it is a failure the plan already knows.
  fs.writeFileSync(
    path.join(outDir, "results-plan.txt"),
    unowned.map((file) => `FAIL test ${file} (unknown package)\n`).join(""),
  );
  fs.writeFileSync(path.join(outDir, "changed.txt"), changed.map((file) => `${file}\n`).join(""));

  console.error(`${changed.length} changed files; ${expected.length} receipt items.`);
  for (const group of typecheck) console.error(`typecheck ${group.id}: ${group.dirs}`);
  for (const shard of shards) {
    console.error(`test ${shard.id} (~${shard.seconds}s${shard.chromium ? ", chromium" : ""}): ${shard.files}`);
  }
  console.log(`lint=${lint}`);
  console.log(`typecheck=${JSON.stringify(typecheck)}`);
  console.log(`tests=${JSON.stringify(shards)}`);
}

main();

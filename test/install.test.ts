import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const project = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { scripts?: Record<string, string>; version: string };

test("installer dry-run is non-destructive and points to onboarding", () => {
  const result = spawnSync("bash", ["install.sh", "--dry-run", "--no-onboard"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /releases\/latest\/download\/threadferry\.tgz/);
  assert.doesNotMatch(result.stdout, /npm (ci|run build)/);
  assert.match(result.stdout, /threadferry onboard/);
  assert.doesNotMatch(result.stdout, /sudo/);
});

test("installer supports curl-pipe execution", () => {
  const script = readFileSync(fileURLToPath(new URL("../../install.sh", import.meta.url)), "utf8");
  const result = spawnSync("bash", ["-s", "--", "--dry-run", "--no-onboard"], {
    cwd: project,
    encoding: "utf8",
    input: script,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /BASH_SOURCE/);
  assert.match(result.stdout, /releases\/latest\/download\/threadferry\.tgz/);
  assert.doesNotMatch(result.stdout, /git\+https:|npm (ci|run build)/);
  assert.match(result.stdout, /threadferry onboard/);
});

test("installer installs the official wecom CLI when it is missing", () => {
  const temporary = mkdtempSync(join(tmpdir(), "threadferry-wecom-dependency-"));
  try {
    const commandDirectory = join(temporary, "commands");
    mkdirSync(commandDirectory);
    const fakeNode = join(commandDirectory, "node");
    const fakeNpm = join(commandDirectory, "npm");
    writeFileSync(fakeNode, "#!/usr/bin/env bash\nprintf '22\\n'\n");
    writeFileSync(fakeNpm, `#!/usr/bin/env bash
if [[ "$1 $2" == "root --global" ]]; then
  printf '%s\\n' "${temporary}/prefix/lib/node_modules"
elif [[ "$1 $2" == "prefix --global" ]]; then
  printf '%s\\n' "${temporary}/prefix"
else
  exit 99
fi
`);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    const result = spawnSync("/bin/bash", ["install.sh", "--dry-run", "--no-onboard"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, PATH: `${commandDirectory}:/usr/bin:/bin` },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing official wecom-cli/);
    assert.match(result.stdout, /npm install --global @wecom\/cli/);
    assert.ok(result.stdout.indexOf("@wecom/cli") < result.stdout.indexOf("threadferry.tgz"));
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("installer offers to reuse configured wecom CLI credentials", () => {
  const temporary = mkdtempSync(join(tmpdir(), "threadferry-wecom-configured-"));
  try {
    const commandDirectory = join(temporary, "commands");
    mkdirSync(commandDirectory);
    writeFileSync(join(commandDirectory, "node"), "#!/usr/bin/env bash\nprintf '22\\n'\n");
    writeFileSync(join(commandDirectory, "npm"), `#!/usr/bin/env bash
if [[ "$1 $2" == "root --global" ]]; then
  printf '%s\\n' "${temporary}/prefix/lib/node_modules"
elif [[ "$1 $2" == "prefix --global" ]]; then
  printf '%s\\n' "${temporary}/prefix"
fi
`);
    writeFileSync(join(commandDirectory, "wecom-cli"), `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  printf 'wecom-cli 1.1.0\\n'
elif [[ "$*" == "auth show --status" ]]; then
  printf 'authorized\\n'
fi
`);
    writeFileSync(join(commandDirectory, "threadferry"), "#!/usr/bin/env bash\nprintf '0.10.1\\n'\n");
    for (const command of ["node", "npm", "wecom-cli", "threadferry"]) {
      chmodSync(join(commandDirectory, command), 0o755);
    }

    const result = spawnSync("/bin/bash", ["install.sh", "--no-onboard"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, PATH: `${commandDirectory}:/usr/bin:/bin` },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /wecom-cli is already configured/);
    assert.match(result.stdout, /ask whether to reuse the saved credentials/);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("release package contains the compiled CLI without a consumer build hook", () => {
  assert.equal(packageMetadata.scripts?.prepare, undefined);

  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ files }] = JSON.parse(packed.stdout) as [{ files: Array<{ path: string }> }];
  assert.ok(files.some(({ path }) => path === "dist/src/cli.js"));
  assert.ok(files.every(({ path }) => !path.startsWith("src/")));
});

test("release workflow publishes curated changelog notes", () => {
  const workflow = readFileSync(join(project, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /scripts\/release-notes\.mjs/);
  assert.match(workflow, /--notes-file release\/RELEASE_NOTES\.md/);
  assert.doesNotMatch(workflow, /--generate-notes/);

  const notes = spawnSync(process.execPath, ["scripts/release-notes.mjs", packageMetadata.version], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(notes.status, 0, notes.stderr);
  assert.match(notes.stdout, /## 主要变化/);
  assert.match(notes.stdout, /## 安装与升级/);
});

test("main pushes trigger build verification", () => {
  const workflow = readFileSync(join(project, ".github", "workflows", "build.yml"), "utf8");
  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(workflow, /gh release create/);
});

test("remote installer replaces an existing linked development install", () => {
  const temporary = mkdtempSync(join(tmpdir(), "threadferry-installer-"));
  try {
    const commandDirectory = join(temporary, "commands");
    const prefix = join(temporary, "prefix");
    const globalRoot = join(prefix, "lib", "node_modules");
    mkdirSync(commandDirectory, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(project, join(globalRoot, "threadferry"));
    symlinkSync("../lib/node_modules/threadferry/dist/src/cli.js", join(prefix, "bin", "threadferry"));

    const fakeNpm = join(commandDirectory, "npm");
    writeFileSync(
      fakeNpm,
      `#!/usr/bin/env bash
if [[ "$1 $2" == "root --global" ]]; then
  printf '%s\\n' "$THREADFERRY_TEST_NPM_ROOT"
elif [[ "$1 $2" == "prefix --global" ]]; then
  printf '%s\\n' "$THREADFERRY_TEST_NPM_PREFIX"
else
  exit 99
fi
`,
    );
    chmodSync(fakeNpm, 0o755);

    const script = readFileSync(fileURLToPath(new URL("../../install.sh", import.meta.url)), "utf8");
    const result = spawnSync("bash", ["-s", "--", "--dry-run", "--no-onboard"], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
        THREADFERRY_TEST_NPM_PREFIX: prefix,
        THREADFERRY_TEST_NPM_ROOT: globalRoot,
      },
      input: script,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`unlink ${join(prefix, "bin", "threadferry")}`));
    assert.match(result.stdout, new RegExp(`unlink ${join(globalRoot, "threadferry")}`));
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("CLI exposes package version and rejects non-interactive onboarding", () => {
  const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageMetadata.version);

  const onboard = spawnSync(process.execPath, [cli, "onboard"], { encoding: "utf8" });
  assert.equal(onboard.status, 1);
  assert.match(onboard.stderr, /需要交互式终端/);
});

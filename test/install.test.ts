import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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

test("Windows installer uses native PowerShell without WSL", () => {
  const script = readFileSync(fileURLToPath(new URL("../../install.ps1", import.meta.url)), "utf8");
  assert.match(script, /param\([\s\S]*\[switch\] \$NoOnboard[\s\S]*\[switch\] \$DryRun/);
  assert.match(script, /releases\/latest\/download\/threadferry\.tgz/);
  assert.match(script, /@wecom\/cli/);
  assert.match(script, /"--global", "--ignore-scripts", \$ReleasePackageUrl/);
  assert.match(script, /"\$Name\.cmd"/);
  assert.match(script, /ThreadFerry will ask whether to reuse its saved credentials/);
  assert.doesNotMatch(script, /\/bin\/bash|wsl\.exe|install\.sh\s*\|/i);
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
  assert.ok(files.some(({ path }) => path === "install.ps1"));
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

test("release workflow publishes directly installable desktop packages", () => {
  const workflow = readFileSync(join(project, ".github", "workflows", "release.yml"), "utf8");

  for (const runner of ["macos-latest", "windows-latest", "ubuntu-latest"]) assert.match(workflow, new RegExp(`os: ${runner}`));
  for (const extension of ["dmg", "zip", "exe", "AppImage", "deb"]) assert.match(workflow, new RegExp(`release/desktop/\\*\\.${extension}`));
  assert.match(workflow, /needs: \[cli, desktop\]/);
  assert.match(workflow, /merge-multiple: true/);
  assert.match(workflow, /sha256sum > SHA256SUMS/);
});

test("main pushes trigger build verification", () => {
  const workflow = readFileSync(join(project, ".github", "workflows", "build.yml"), "utf8");
  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /runs-on: windows-latest[\s\S]*\.\\install\.ps1 -DryRun -NoOnboard/);
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

test("agent list reports each agent's bot authorization and guides the unauthorized ones", () => {
  const root = mkdtempSync(join(tmpdir(), "threadferry-agent-list-"));
  try {
    const workspace = realpathSync(root);
    const configPath = join(root, "threadferry.yaml");
    writeFileSync(configPath, [
      "version: 6",
      "agents:",
      "  default:",
      "    runtime: codex",
      `    workspace: ${JSON.stringify(workspace)}`,
      "    owner_user: owner",
      "  reviewer:",
      "    runtime: pi",
      `    workspace: ${JSON.stringify(workspace)}`,
      "    owner_user: owner",
      "",
    ].join("\n"));

    // HOME 指向临时目录，避免读到本机真实凭据导致结果随机器变化。
    // 只给 default 造一份凭据，reviewer 保持未授权。
    const home = join(root, "home");
    const defaultDir = join(home, ".threadferry", "wecom", "default");
    mkdirSync(defaultDir, { recursive: true });
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const sealed = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify({ bot: { id: "aib-default", secret: "s3cr3t" } }), "utf8")),
      cipher.final(),
    ]);
    writeFileSync(join(defaultDir, ".encryption_key"), key.toString("base64"));
    writeFileSync(join(defaultDir, "credentials.enc"), Buffer.concat([nonce, sealed, cipher.getAuthTag()]));

    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete environment.WECOM_CLI_CONFIG_DIR;

    const listed = spawnSync(process.execPath, [cli, "agent", "list", "--config", configPath], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(listed.status, 0, listed.stderr);
    const rows = listed.stdout.split("\n").filter((line) => line.includes("\t"));
    assert.equal(rows.length, 2);
    assert.match(rows[0] ?? "", /^default\tcodex\tdefault\t.*\taib-default$/);
    // reviewer 没有独立凭据目录，必须报未授权并给出可执行的下一步。
    assert.match(rows[1] ?? "", /^reviewer\tpi\tdefault\t.*\t未授权$/);
    assert.match(listed.stdout, /WECOM_CLI_CONFIG_DIR=.*wecom-cli auth init/s);
    assert.match(listed.stdout, /threadferry agent login reviewer/);
    // 已授权的 default 不该再出现引导文案。
    assert.doesNotMatch(listed.stdout, /agent login default/);
    // 授权状态里绝不能出现 Secret。
    assert.doesNotMatch(listed.stdout, /s3cr3t/);

    const unknown = spawnSync(process.execPath, [cli, "agent", "login", "nope", "--config", configPath], { encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Agent nope 未配置/);

    const missing = spawnSync(process.execPath, [cli, "agent", "login", "--config", configPath], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /必须提供 Agent 名/);

    // 中文 Agent 名（含空格）是合法目录名，v5 起支持，配置可以正常加载并按未授权列出。
    const chinesePath = join(root, "chinese.yaml");
    writeFileSync(chinesePath, [
      "version: 6",
      "agents:",
      "  代码审查:",
      "    runtime: codex",
      `    workspace: ${JSON.stringify(workspace)}`,
      "    owner_user: owner",
      "",
    ].join("\n"));
    const chinese = spawnSync(process.execPath, [cli, "agent", "list", "--config", chinesePath], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(chinese.status, 0, chinese.stderr);
    assert.match(chinese.stdout, /^代码审查\tcodex/);
    assert.match(chinese.stdout, /未授权/);

    // 但路径穿越、路径分隔符和控制字符仍然被拒绝。
    const badPath = join(root, "bad.yaml");
    writeFileSync(badPath, [
      "version: 6",
      "agents:",
      "  ../escape:",
      "    runtime: codex",
      `    workspace: ${JSON.stringify(workspace)}`,
      "    owner_user: owner",
      "",
    ].join("\n"));
    const badPathResult = spawnSync(process.execPath, [cli, "agent", "list", "--config", badPath], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(badPathResult.status, 1);
    assert.match(badPathResult.stderr, /不能包含路径分隔符/);

    const bad = spawnSync(process.execPath, [cli, "agent", "nope", "--config", configPath], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /仅支持 add、list 或 login/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("start reports which agents lack bot credentials instead of failing silently", () => {
  const root = mkdtempSync(join(tmpdir(), "threadferry-start-agents-"));
  try {
    const workspace = realpathSync(root);
    const configPath = join(root, "threadferry.yaml");
    writeFileSync(configPath, [
      "version: 6",
      "agents:",
      "  frontend:",
      "    runtime: codex",
      `    workspace: ${JSON.stringify(workspace)}`,
      "    owner_user: owner-a",
      "  backend:",
      "    runtime: codex",
      `    workspace: ${JSON.stringify(workspace)}`,
      "    owner_user: owner-b",
      "",
    ].join("\n"));
    // HOME 指向空目录：两个 Agent 都没有凭据，启动必须逐个报出来再失败。
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home") };
    delete environment.WECOM_CLI_CONFIG_DIR;
    const run = (extra: string[]) => spawnSync(process.execPath, [cli, "start", "--config", configPath, ...extra], {
      encoding: "utf8",
      env: environment,
    });

    const all = run([]);
    assert.equal(all.status, 1);
    assert.match(all.stderr, /跳过 Agent frontend/);
    assert.match(all.stderr, /跳过 Agent backend/);
    assert.match(all.stderr, /threadferry agent login frontend/);
    assert.match(all.stderr, /没有任何待启动的 Agent 拥有机器人凭据/);

    // --agents 只启动被选中的，未选中的不该被提及。
    const one = run(["--agents", "backend"]);
    assert.equal(one.status, 1);
    assert.match(one.stderr, /跳过 Agent backend/);
    assert.doesNotMatch(one.stderr, /跳过 Agent frontend/);

    // 选了不存在的 Agent 要直说，而不是报「没有凭据」。
    const unknown = run(["--agents", "nope"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /--agents 指定了未配置的 Agent: nope/);
    assert.match(unknown.stderr, /已配置: frontend, backend/);
  } finally {
    rmSync(root, { force: true, recursive: true });
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

test("start checks for updates before first-time onboarding", () => {
  const root = mkdtempSync(join(tmpdir(), "threadferry-update-start-"));
  try {
    const preload = join(root, "latest-release.mjs");
    writeFileSync(preload, `globalThis.fetch = async () => new Response(null, {
  status: 302,
  headers: { location: "https://github.com/GnaixEuy/threadferry/releases/tag/v${packageMetadata.version}" },
});\n`);
    const result = spawnSync(process.execPath, [
      "--import", preload, cli, "start", "--config", join(root, "missing.yaml"),
    ], { encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`\\[update\\] 已检查，ThreadFerry ${packageMetadata.version.replaceAll(".", "\\.")} 已是最新版本`));
    assert.match(result.stderr, /配置不存在/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("setup and onboard reject invalid timeout values before touching the terminal", () => {
  for (const command of ["setup", "onboard"]) {
    for (const value of ["abc", "0", "-5"]) {
      const result = spawnSync(process.execPath, [cli, command, "--timeout", value], { encoding: "utf8" });
      assert.equal(result.status, 1, `${command} --timeout ${value} should fail`);
      assert.match(result.stderr, /--timeout 必须是大于 0 的秒数/);
    }
  }
});

test("setup requires an interactive terminal and help documents the optional workspace", () => {
  const setup = spawnSync(process.execPath, [cli, "setup"], { encoding: "utf8" });
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /需要交互式终端/);

  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /threadferry setup \[--workspace <absolute-path>\]/);
});

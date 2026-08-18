#!/usr/bin/env node
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\r?\n/);
const start = lines.findIndex((line) => line === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG.md 缺少版本 ${version} 的发布说明`);
  process.exit(1);
}

const nextVersion = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const section = lines.slice(start + 1, nextVersion === -1 ? undefined : nextVersion).join("\n").trim();
if (section.length < 200 || !section.includes("### 主要变化") || !section.includes("### 安装与升级")) {
  console.error(`CHANGELOG.md 中 ${version} 的发布说明不完整`);
  process.exit(1);
}

process.stdout.write(`${section.replace(/^### /gm, "## ").replace(/^#### /gm, "### ")}\n`);

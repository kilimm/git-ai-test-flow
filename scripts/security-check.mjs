#!/usr/bin/env node
// 本文件所有改动要求遵循 agent-rules 规范
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOTS = ['apps', 'packages', 'scripts'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.sql']);
const IGNORED = new Set(['node_modules', 'dist', 'coverage', '.git']);

const PRODUCT_COMMAND_PATTERNS = [
  /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*['"`](?:npm|pnpm|yarn|npx|bun)\b/,
  /\bshell\s*:\s*true\b/,
  /\b(?:npm|pnpm|yarn)\s+(?:install|run\s+build|run\s+start|test)\b/,
];

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ENCRYPTION_KEY\s*=\s*[A-Za-z0-9+/]{40,}={0,2}/,
];

/**
 * @param {string} directory
 * @returns {Generator<string>}
 */
function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (IGNORED.has(entry)) {
      continue;
    }

    const absolute = join(directory, entry);
    const stat = statSync(absolute);

    if (stat.isDirectory()) {
      yield* walk(absolute);
    } else if (stat.isFile() && EXTENSIONS.has(extname(entry))) {
      yield absolute;
    }
  }
}

/** @typedef {{ file: string, line: number, type: string, message: string }} SecurityFinding */
/** @type {SecurityFinding[]} */
const findings = [];

for (const root of ROOTS) {
  let files;

  try {
    files = [...walk(root)];
  } catch {
    continue;
  }

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      for (const pattern of PRODUCT_COMMAND_PATTERNS) {
        if (pattern.test(line)) {
          findings.push({
            file,
            line: index + 1,
            type: 'product-command',
            message: '平台代码不得执行产品仓库命令，也不得启用 shell 模式',
          });
        }
      }

      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          findings.push({
            file,
            line: index + 1,
            type: 'hardcoded-secret',
            message: '发现疑似硬编码密钥',
          });
        }
      }
    });
  }
}

// 测试与示例中会出现用于证明扫描有效的字符串，排除测试清单本身。
const actionable = findings.filter(
  (finding) => !finding.file.replaceAll('\\', '/').includes('/test/'),
);

if (actionable.length > 0) {
  for (const finding of actionable) {
    process.stderr.write(`${finding.file}:${finding.line} [${finding.type}] ${finding.message}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write('Security source scan passed (no product commands or hardcoded secrets).\n');
}

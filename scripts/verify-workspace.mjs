import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const requiredFiles = [
  '.editorconfig',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc.json',
  'eslint.config.mjs',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.scripts.json',
];

const requiredDirectories = ['apps', 'packages', 'scripts'];

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  errors.push(`Node.js >= 22.12.0 is required, current version is ${process.versions.node}`);
}

/**
 * @typedef {{
 *   packageManager?: string,
 *   engines?: { node?: string }
 * }} PackageJson
 */

/** @type {PackageJson} */
let packageJson = {};
try {
  packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
} catch (error) {
  errors.push(
    `Unable to read package.json: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (
  typeof packageJson.packageManager !== 'string' ||
  !packageJson.packageManager.startsWith('pnpm@')
) {
  errors.push('package.json must declare packageManager as pnpm@<version>');
}

if (typeof packageJson.engines?.node !== 'string' || packageJson.engines.node.length === 0) {
  errors.push('package.json must declare engines.node');
}

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) {
    errors.push(`Missing required file: ${file}`);
  }
}

for (const directory of requiredDirectories) {
  if (!existsSync(resolve(root, directory))) {
    errors.push(`Missing required directory: ${directory}`);
  }
}

if (existsSync(resolve(root, 'pnpm-workspace.yaml'))) {
  const workspace = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
  for (const pattern of ['apps/*', 'packages/*']) {
    if (!workspace.includes(pattern)) {
      errors.push(`pnpm-workspace.yaml must include ${pattern}`);
    }
  }
}

if (errors.length > 0) {
  console.error('Workspace verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Workspace verified: Node ${process.versions.node}, package manager ${packageJson.packageManager}`,
);

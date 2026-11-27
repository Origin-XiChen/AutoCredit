import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installerDir = join(root, 'installer')
const resourcesDir = join(installerDir, 'src-tauri', 'resources')
const embedded = join(resourcesDir, 'setup-embedded.exe')

function prepare() {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const setup = join(
    root,
    'src-tauri',
    'target',
    'release',
    'bundle',
    'nsis',
    `AutoCredit_${version}_x64-setup.exe`,
  )
  if (!existsSync(setup)) {
    console.error(`找不到主程序安装包：${setup}`)
    console.error('请先运行 npm run tauri:build')
    process.exit(1)
  }
  mkdirSync(resourcesDir, { recursive: true })
  copyFileSync(setup, embedded)
  console.log(`已复制主程序安装包 v${version}`)
  return version
}

function run(command, args, cwd = root) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: needsShell })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function build() {
  const version = prepare()
  run(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'installer/vite.config.ts'])
  const tauri = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
  run(tauri, ['build'], installerDir)
  const bin = join(installerDir, 'src-tauri', 'target', 'release', 'autocredit-installer.exe')
  const outDir = join(installerDir, 'release')
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `AutoCredit-Setup-${version}.exe`)
  copyFileSync(bin, out)
  console.log(`安装引导器：${out}`)
}

function dev() {
  prepare()
  const vite = spawn(
    process.execPath,
    [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'installer/vite.config.ts'],
    { cwd: root, stdio: 'inherit' },
  )
  const tauri = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
  const app = spawn(tauri, ['dev'], {
    cwd: installerDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  const stop = () => {
    app.kill()
    vite.kill()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

const command = process.argv[2]
if (command === 'prepare') prepare()
else if (command === 'build') build()
else if (command === 'dev') dev()
else {
  console.error('用法：node scripts/installer.mjs <prepare|build|dev>')
  process.exit(1)
}

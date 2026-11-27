import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './styles.css'

interface AppInfo {
  version: string
  defaultPath: string
}

interface StatusPayload {
  stage: string
  message: string
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const menu = el<HTMLDivElement>('menu')
const menuBtn = el<HTMLButtonElement>('menuBtn')
const installBtn = el<HTMLButtonElement>('installBtn')
const browseBtn = el<HTMLButtonElement>('browseBtn')
const cancelBtn = el<HTMLButtonElement>('cancelBtn')
const closeBtn = el<HTMLButtonElement>('closeBtn')
const minBtn = el<HTMLButtonElement>('minBtn')
const pathInput = el<HTMLInputElement>('pathInput')
const status = el<HTMLDivElement>('status')
const statusText = el<HTMLSpanElement>('statusText')
const versionText = el<HTMLParagraphElement>('version')
const optShortcut = el<HTMLInputElement>('optShortcut')
const optAutoStart = el<HTMLInputElement>('optAutoStart')
const optLaunch = el<HTMLInputElement>('optLaunch')

let installPath = ''
let installing = false

function closeWindow(): void {
  if (installing) return
  document.querySelector('.window')?.classList.add('closing')
  window.setTimeout(() => void invoke('quit'), 140)
}

function setMenu(open: boolean): void {
  menu.hidden = !open
  menuBtn.classList.toggle('active', open)
}

function setStatus(kind: 'running' | 'success' | 'error' | 'hidden', message = ''): void {
  if (kind === 'hidden') {
    status.hidden = true
    return
  }
  status.hidden = false
  status.className = `status ${kind}`
  statusText.textContent = message
}

async function init(): Promise<void> {
  const info = await invoke<AppInfo>('app_info')
  versionText.textContent = `v${info.version} · 每日自动签到`
  installPath = info.defaultPath
  pathInput.value = installPath
  pathInput.title = installPath
}

menuBtn.addEventListener('click', (event) => {
  event.stopPropagation()
  setMenu(menu.hidden)
})

menu.addEventListener('click', (event) => event.stopPropagation())

document.addEventListener('click', () => setMenu(false))

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!menu.hidden) {
      setMenu(false)
    } else {
      closeWindow()
    }
  }
})

minBtn.addEventListener('click', () => void invoke('minimize'))

closeBtn.addEventListener('click', () => closeWindow())

cancelBtn.addEventListener('click', () => closeWindow())

browseBtn.addEventListener('click', async () => {
  const picked = await invoke<string | null>('pick_folder')
  if (picked) {
    installPath = picked
    pathInput.value = picked
    pathInput.title = picked
  }
})

pathInput.addEventListener('input', () => {
  installPath = pathInput.value
  pathInput.title = pathInput.value
})

pathInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    installBtn.click()
  }
})

async function startInstall(): Promise<void> {
  if (installing) return
  const target = installPath.trim()
  if (!/^[a-zA-Z]:\\|^\\\\/.test(target)) {
    setStatus('error', '请选择有效的安装路径')
    pathInput.focus()
    return
  }
  installPath = target
  pathInput.value = target
  pathInput.title = target

  installing = true
  setMenu(false)
  installBtn.disabled = true
  installBtn.textContent = '正在安装…'
  pathInput.disabled = true
  browseBtn.disabled = true
  cancelBtn.disabled = true
  closeBtn.disabled = true
  setStatus('running', '正在准备安装…')

  const unlisten = await listen<StatusPayload>('install:status', (event) => {
    setStatus('running', event.payload.message)
  })

  try {
    await invoke('install', {
      options: {
        path: target,
        createShortcut: optShortcut.checked,
        autoStart: optAutoStart.checked,
        launchAfter: optLaunch.checked,
      },
    })
    setStatus('success', optLaunch.checked ? '安装完成，AutoCredit 已启动' : '安装完成')
    installBtn.textContent = '安装完成'
    installing = false
    cancelBtn.disabled = false
    cancelBtn.textContent = '关闭'
    closeBtn.disabled = false
    if (optLaunch.checked) {
      window.setTimeout(closeWindow, 2200)
    }
  } catch (error) {
    setStatus('error', String(error))
    installBtn.disabled = false
    installBtn.textContent = '重试安装'
    pathInput.disabled = false
    browseBtn.disabled = false
    cancelBtn.disabled = false
    closeBtn.disabled = false
    installing = false
  } finally {
    unlisten()
  }
}

installBtn.addEventListener('click', () => void startInstall())

void init()

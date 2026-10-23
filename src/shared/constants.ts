import type { AppId, AppMeta, ConfigFile, GlobalSettings } from './types'

export const APP_ORDER: AppId[] = ['trae', 'qoder', 'qoder-cn', 'workbuddy', 'doubao']

/** 豆包属于实验功能，只在设置中开启开发者模式后才出现。 */
export function visibleAppIds(settings: { developerMode: boolean }): AppId[] {
  return APP_ORDER.filter((id) => id !== 'doubao' || settings.developerMode)
}

export const APP_META: Record<AppId, AppMeta> = {
  trae: {
    id: 'trae',
    name: 'Trae CN',
    fullName: 'Trae CN',
    description: '读取本机 Trae CN 登录态，自动领取每日签到积分',
    autoAuth: true,
    accountHint: '自动读取本机 Trae CN 客户端登录态',
    note: '仅中国版（trae.cn）有每日签到，国际版（trae.ai）无需签到',
  },
  qoder: {
    id: 'qoder',
    name: 'Qoder',
    fullName: 'Qoder 国际版',
    description: '使用个人访问令牌领取每日 100 Credits',
    autoAuth: false,
    patUrl: 'https://qoder.com/account/integrations',
    accountHint: '需要一次性保存 Qoder 个人访问令牌（PAT）',
  },
  'qoder-cn': {
    id: 'qoder-cn',
    name: 'Qoder CN',
    fullName: 'Qoder CN / QoderWork',
    description: '使用个人访问令牌领取每日 100 Credits',
    autoAuth: false,
    patUrl: 'https://qoder.com.cn/account/integrations',
    accountHint: '需要一次性保存 Qoder CN 个人访问令牌（PAT）',
  },
  workbuddy: {
    id: 'workbuddy',
    name: 'WorkBuddy',
    fullName: 'WorkBuddy',
    description: '读取本机 WorkBuddy 登录态，自动领取 Buddy 加油站积分',
    autoAuth: true,
    accountHint: '自动读取本机 WorkBuddy 客户端登录态',
    note: '仅中国版（codebuddy.cn）有每日签到，国际版无需签到',
  },
  doubao: {
    id: 'doubao',
    name: '豆包',
    fullName: '豆包桌面端',
    description: '通过豆包客户端调试端口模拟领取每日额度（实验功能，默认隐藏）',
    autoAuth: true,
    accountHint: '需要本机安装并登录豆包桌面端；签到时会自动启动客户端',
  },
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  masterEnabled: false,
  defaultTime: '10:10',
  autoLaunch: false,
  startMinimized: true,
  closeToTray: true,
  theme: 'system',
  logRetentionDays: 14,
  developerMode: false,
  allowPrerelease: false,
}

export const DEFAULT_CONFIG: Omit<ConfigFile, 'machineId' | 'createdAt'> = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  apps: {
    trae: { enabled: true, useCustomTime: false, time: '10:10' },
    qoder: { enabled: true, useCustomTime: false, time: '10:10' },
    'qoder-cn': { enabled: true, useCustomTime: false, time: '10:10' },
    workbuddy: { enabled: true, useCustomTime: false, time: '10:10' },
    doubao: { enabled: false, useCustomTime: false, time: '10:10' },
  },
  runtime: {
    trae: { status: 'idle', message: '等待签到', attempts: 0 },
    qoder: { status: 'idle', message: '等待签到', attempts: 0 },
    'qoder-cn': { status: 'idle', message: '等待签到', attempts: 0 },
    workbuddy: { status: 'idle', message: '等待签到', attempts: 0 },
    doubao: { status: 'idle', message: '等待签到', attempts: 0 },
  },
}

export const POPUP_SECONDS = 10

import type { AppId, AppMeta, ConfigFile, GlobalSettings } from './types'

export const APP_ORDER: AppId[] = ['trae', 'qoder', 'qoder-cn', 'workbuddy']

export const APP_META: Record<AppId, AppMeta> = {
  trae: {
    id: 'trae',
    name: 'Trae',
    fullName: 'Trae Work',
    description: '读取本机 Trae 登录态，自动领取每日签到积分',
    autoAuth: true,
    accountHint: '自动读取本机 Trae / Trae CN 客户端登录态',
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
}

export const DEFAULT_CONFIG: Omit<ConfigFile, 'machineId' | 'createdAt'> = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  apps: {
    trae: { enabled: true, useCustomTime: false, time: '10:10' },
    qoder: { enabled: true, useCustomTime: false, time: '10:10' },
    'qoder-cn': { enabled: true, useCustomTime: false, time: '10:10' },
    workbuddy: { enabled: true, useCustomTime: false, time: '10:10' },
  },
  runtime: {
    trae: { status: 'idle', message: '等待签到', attempts: 0 },
    qoder: { status: 'idle', message: '等待签到', attempts: 0 },
    'qoder-cn': { status: 'idle', message: '等待签到', attempts: 0 },
    workbuddy: { status: 'idle', message: '等待签到', attempts: 0 },
  },
}

export const POPUP_SECONDS = 10

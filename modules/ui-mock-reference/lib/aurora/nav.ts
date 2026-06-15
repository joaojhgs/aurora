import {
  Activity,
  Boxes,
  Compass,
  Cpu,
  LayoutDashboard,
  type LucideIcon,
  MessagesSquare,
  Network,
  Settings,
  ShieldCheck,
  Sparkles,
  KeyRound,
  Laptop,
  Plug,
  ScrollText,
  DatabaseBackup,
  Wrench,
} from 'lucide-react'

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
  adminGated?: boolean
  badge?: string
}

export interface NavSection {
  label: string
  items: NavItem[]
}

export const navSections: NavSection[] = [
  {
    label: 'Assistant',
    items: [
      { label: 'Assistant', href: '/', icon: Sparkles },
      { label: 'Memory & Knowledge', href: '/memory', icon: MessagesSquare },
      { label: 'Tools & Automations', href: '/tools', icon: Wrench },
      { label: 'Mesh & Peers', href: '/mesh', icon: Network, badge: '1' },
    ],
  },
  {
    label: 'Operate',
    items: [
      { label: 'Admin Overview', href: '/admin', icon: LayoutDashboard, adminGated: true },
      { label: 'Services', href: '/admin/services', icon: Boxes, adminGated: true },
      { label: 'Access & RBAC', href: '/admin/access', icon: ShieldCheck, adminGated: true },
      { label: 'Tokens', href: '/admin/tokens', icon: KeyRound, adminGated: true },
      { label: 'Devices', href: '/admin/devices', icon: Laptop, adminGated: true },
      { label: 'Configuration', href: '/admin/config', icon: Settings, adminGated: true },
      { label: 'Contracts', href: '/admin/contracts', icon: ScrollText, adminGated: true },
      { label: 'Plugins', href: '/admin/plugins', icon: Plug, adminGated: true },
      { label: 'Pairing', href: '/admin/pairing', icon: Network, adminGated: true, badge: '1' },
      { label: 'Backups', href: '/admin/backups', icon: DatabaseBackup, adminGated: true },
      { label: 'Audit Log', href: '/admin/audit', icon: Activity, adminGated: true },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { label: 'Models & Runtime', href: '/models', icon: Cpu },
      { label: 'Diagnostics', href: '/diagnostics', icon: Activity },
      { label: 'Onboarding', href: '/onboarding', icon: Compass },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
]

export interface MobileTab {
  label: string
  href: string
  icon: LucideIcon
}

export const mobileTabs: MobileTab[] = [
  { label: 'Assistant', href: '/', icon: Sparkles },
  { label: 'Activity', href: '/diagnostics', icon: Activity },
  { label: 'Mesh', href: '/mesh', icon: Network },
  { label: 'Admin', href: '/admin', icon: ShieldCheck },
  { label: 'Settings', href: '/settings', icon: Settings },
]

import type { CloudflareSandbox } from './cloudflare'

export interface BuildSession {
  id: string
  discordThreadId: string
  discordUserId: string
  discordUsername: string
  sandbox: CloudflareSandbox
  sandboxId: string
  branch: string
  prNumber: number
  prUrl: string
  repoPath: string
  createdAt: Date
  status: 'active' | 'completed' | 'error'
}

export interface BuildConfig {
  repoUrl: string
  repoOwner: string
  repoName: string
  defaultBranch: string
}

export const BUILD_CONFIG: BuildConfig = {
  repoUrl: 'https://github.com/gursheyss/boneralbot.git',
  repoOwner: 'gursheyss',
  repoName: 'boneralbot',
  defaultBranch: 'main',
}

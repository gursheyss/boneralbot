import type { CloudflareSandbox } from './cloudflare'
import { BUILD_CONFIG } from './types'
import { executeCommand } from './cloudflare'
import {
  getInstallationToken,
  createPullRequest,
  markPullRequestReady,
} from './github'

const SANDBOX_URL = process.env.CLOUDFLARE_SANDBOX_URL!
const SANDBOX_TOKEN = process.env.SANDBOX_AUTH_TOKEN!

const REPO_PATH = '/workspace/repo'
const GIT_USER = 'x-access-token'

async function gitRequest<T>(
  sandboxId: string,
  action: string,
  body: object
): Promise<T> {
  const response = await fetch(
    `${SANDBOX_URL}/sandbox/${sandboxId}/git/${action}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SANDBOX_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Git operation failed: ${error}`)
  }

  return response.json() as Promise<T>
}

export async function cloneRepo(sandbox: CloudflareSandbox): Promise<void> {
  const token = await getInstallationToken()
  await gitRequest(sandbox.id, 'clone', {
    repoUrl: BUILD_CONFIG.repoUrl,
    branch: BUILD_CONFIG.defaultBranch,
    targetDir: REPO_PATH,
    token,
    username: GIT_USER,
  })
}

export async function createBranch(
  sandbox: CloudflareSandbox,
  branchName: string
): Promise<void> {
  await gitRequest(sandbox.id, 'branch', {
    cwd: REPO_PATH,
    branchName,
  })
}

export async function pushBranch(sandbox: CloudflareSandbox): Promise<void> {
  const token = await getInstallationToken()
  await gitRequest(sandbox.id, 'push', {
    cwd: REPO_PATH,
    token,
    username: GIT_USER,
  })
}

export async function commitAll(
  sandbox: CloudflareSandbox,
  message: string,
  authorName: string,
  allowEmpty = false
): Promise<string | null> {
  const response = await gitRequest<{
    success: boolean
    sha: string | null
    noChanges?: boolean
  }>(sandbox.id, 'commit', {
    cwd: REPO_PATH,
    message,
    authorName,
    authorEmail: 'bot@boneralbot.com',
    allowEmpty,
  })

  if (response.noChanges) {
    return null
  }

  await pushBranch(sandbox)
  return response.sha
}

export async function createDraftPR(
  _sandbox: CloudflareSandbox,
  branch: string,
  title: string,
  body: string
): Promise<{ prNumber: number; prUrl: string }> {
  const { number, url } = await createPullRequest({
    owner: BUILD_CONFIG.repoOwner,
    repo: BUILD_CONFIG.repoName,
    title,
    body,
    head: branch,
    base: BUILD_CONFIG.defaultBranch,
    draft: true,
  })

  return { prNumber: number, prUrl: url }
}

export async function markPRReady(
  _sandbox: CloudflareSandbox,
  prNumber: number
): Promise<void> {
  await markPullRequestReady({
    owner: BUILD_CONFIG.repoOwner,
    repo: BUILD_CONFIG.repoName,
    pullNumber: prNumber,
  })
}

export async function protectSandboxFolder(
  sandbox: CloudflareSandbox
): Promise<void> {
  // Make sandbox directory read-only and ignore it in git commits
  await executeCommand(
    sandbox,
    'chmod -R a-w sandbox || true',
    REPO_PATH
  )
  await executeCommand(
    sandbox,
    'git update-index --skip-worktree sandbox || true',
    REPO_PATH
  )
}

import type { Sandbox } from '@daytonaio/sdk'
import { BUILD_CONFIG } from './types'
import {
  getInstallationToken,
  createPullRequest,
  markPullRequestReady
} from './github'

const REPO_PATH = 'workspace'
const GIT_USER = 'x-access-token'

export async function cloneRepo(sandbox: Sandbox): Promise<void> {
  const token = await getInstallationToken()
  await sandbox.git.clone(
    BUILD_CONFIG.repoUrl,
    REPO_PATH,
    BUILD_CONFIG.defaultBranch,
    undefined,
    GIT_USER,
    token
  )
}

export async function createBranch(
  sandbox: Sandbox,
  branchName: string
): Promise<void> {
  await sandbox.git.createBranch(REPO_PATH, branchName)
  await sandbox.git.checkoutBranch(REPO_PATH, branchName)
}

export async function pushBranch(sandbox: Sandbox): Promise<void> {
  const token = await getInstallationToken()
  await sandbox.git.push(REPO_PATH, GIT_USER, token)
}

export async function commitAll(
  sandbox: Sandbox,
  message: string,
  authorName: string
): Promise<string | null> {
  const status = await sandbox.git.status(REPO_PATH)

  if (!status.fileStatus || status.fileStatus.length === 0) {
    return null
  }

  await sandbox.git.add(REPO_PATH, ['.'])

  const commit = await sandbox.git.commit(
    REPO_PATH,
    message,
    authorName,
    'bot@boneralbot.com'
  )

  await pushBranch(sandbox)

  return commit.sha
}

export async function createDraftPR(
  _sandbox: Sandbox,
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
    draft: true
  })

  return { prNumber: number, prUrl: url }
}

export async function markPRReady(
  _sandbox: Sandbox,
  prNumber: number
): Promise<void> {
  await markPullRequestReady({
    owner: BUILD_CONFIG.repoOwner,
    repo: BUILD_CONFIG.repoName,
    pullNumber: prNumber
  })
}

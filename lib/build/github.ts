import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'

let cachedToken: { token: string; expiresAt: Date } | null = null

export async function getInstallationToken(): Promise<string> {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && cachedToken.expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
    return cachedToken.token
  }

  const appId = process.env.GITHUB_APP_ID
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n')
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID

  if (!appId || !privateKey || !installationId) {
    throw new Error('Missing GitHub App credentials (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID)')
  }

  const auth = createAppAuth({
    appId,
    privateKey,
    installationId
  })

  const { token, expiresAt } = await auth({ type: 'installation' })

  cachedToken = { token, expiresAt: new Date(expiresAt) }

  return token
}

export async function getOctokit(): Promise<Octokit> {
  const token = await getInstallationToken()
  return new Octokit({ auth: token })
}

export async function createPullRequest(args: {
  owner: string
  repo: string
  title: string
  body: string
  head: string
  base: string
  draft?: boolean
}): Promise<{ number: number; url: string }> {
  const octokit = await getOctokit()

  const { data } = await octokit.pulls.create({
    owner: args.owner,
    repo: args.repo,
    title: args.title,
    body: args.body,
    head: args.head,
    base: args.base,
    draft: args.draft ?? true
  })

  return { number: data.number, url: data.html_url }
}

export async function markPullRequestReady(args: {
  owner: string
  repo: string
  pullNumber: number
}): Promise<void> {
  const octokit = await getOctokit()

  await octokit.pulls.update({
    owner: args.owner,
    repo: args.repo,
    pull_number: args.pullNumber,
    draft: false
  })
}

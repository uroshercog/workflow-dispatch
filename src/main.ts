// ----------------------------------------------------------------------------
// Copyright (c) Ben Coleman, 2020
// Licensed under the MIT License.
//
// Workflow Dispatch Action - Main task code
// ----------------------------------------------------------------------------

import * as core from '@actions/core'
import {createAppAuth} from '@octokit/auth-app'
import {Octokit} from '@octokit/rest'
import { formatDuration, getArgs, isTimedOut, sleep } from './utils'
import { WorkflowHandler, WorkflowRunConclusion, WorkflowRunResult, WorkflowRunStatus } from './workflow-handler'
import { handleWorkflowLogsPerJob } from './workflow-logs-handler'


async function getFollowUrl(workflowHandler: WorkflowHandler, interval: number, timeout: number) {
  const start = Date.now()
  let url
  do {
    await sleep(interval)
    try {
      const result = await workflowHandler.getWorkflowRunStatus()
      url = result.url
    } catch(e: any) {
      core.debug(`Failed to get workflow url: ${e.message}`)
    }
  } while (!url && !isTimedOut(start, timeout))
  return url
}

async function waitForCompletionOrTimeout(workflowHandler: WorkflowHandler, checkStatusInterval: number, waitForCompletionTimeout: number) {
  const start = Date.now()
  let status
  let result
  do {
    await sleep(checkStatusInterval)
    try {
      result = await workflowHandler.getWorkflowRunStatus()
      status = result.status
      core.debug(`Worflow is running for ${formatDuration(Date.now() - start)}. Current status=${status}`)
    } catch(e: any) {
      core.warning(`Failed to get workflow status: ${e.message}`)
    }
  } while (status !== WorkflowRunStatus.COMPLETED && !isTimedOut(start, waitForCompletionTimeout))
  return { result, start }
}

function computeConclusion(start: number, waitForCompletionTimeout: number, result?: WorkflowRunResult) {
  if (isTimedOut(start, waitForCompletionTimeout)) {
    core.info('Workflow wait timed out')
    core.setOutput('workflow-conclusion', WorkflowRunConclusion.TIMED_OUT)
    throw new Error('Workflow run has failed due to timeout')
  }

  core.info(`Workflow completed with conclusion=${result?.conclusion}`)
  const conclusion = result?.conclusion
  core.setOutput('workflow-conclusion', conclusion)

  if (conclusion === WorkflowRunConclusion.FAILURE)   throw new Error('Workflow run has failed')
  if (conclusion === WorkflowRunConclusion.CANCELLED) throw new Error('Workflow run was cancelled')
  if (conclusion === WorkflowRunConclusion.TIMED_OUT) throw new Error('Workflow run has failed due to timeout')
}

async function handleLogs(octokit: Octokit, args: any, workflowHandler: WorkflowHandler) {
  try {
    const workflowRunId = await workflowHandler.getWorkflowRunId()
    await handleWorkflowLogsPerJob(octokit, args, workflowRunId)
  } catch(e: any) {
    core.error(`Failed to handle logs of triggered workflow. Cause: ${e}`)
  }
}

async function setupOctokit(token: string, appId: string, appPrivateKey: string):Promise<Octokit> {
  if(token) {
    return new Octokit({
      auth: token
    })
  }

  return setupGitHubAppOctokit(appId, appPrivateKey)
}

async function setupGitHubAppOctokitClient(appId: string, privateKey: string, installationId?: any):Promise<Octokit> {
  const auth : any = {
    appId,
    privateKey,
  }

  if(installationId) {
    auth.installationId = installationId
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth,
  })
}

async function setupGitHubAppOctokit(appId: string, privateKey: string):Promise<Octokit> {
  const octokit = await setupGitHubAppOctokitClient(appId, privateKey)

  const installations = await octokit.apps.listInstallations()
  const installationId = installations.data[0].id

  core.info(`Using installationId=${installationId}`)

  // Recreate octokit with installationId which results in
  // auto refresh of the token.
  return setupGitHubAppOctokitClient(appId, privateKey, installationId)
}

//
// Main task function (async wrapper)
//
async function run(): Promise<void> {
  try {
    const args = getArgs()

    const octokit = await setupOctokit(args.token, args.appId, args.appPrivateKey)
    const workflowHandler = new WorkflowHandler(octokit, args.workflowRef, args.owner, args.repo, args.ref, args.runName)

    // Trigger workflow run
    await workflowHandler.triggerWorkflow(args.inputs)
    core.info('Workflow triggered 🚀')

    if (args.displayWorkflowUrl) {
      const url = await getFollowUrl(workflowHandler, args.displayWorkflowUrlInterval, args.displayWorkflowUrlTimeout)
      core.info(`You can follow the running workflow here: ${url}`)
      core.setOutput('workflow-url', url)
    }

    if (!args.waitForCompletion) {
      return
    }

    core.info('Waiting for workflow completion')
    const { result, start } = await waitForCompletionOrTimeout(workflowHandler, args.checkStatusInterval, args.waitForCompletionTimeout)

    await handleLogs(octokit, args, workflowHandler)

    core.setOutput('workflow-id', result?.id)
    core.setOutput('workflow-url', result?.url)
    computeConclusion(start, args.waitForCompletionTimeout, result)

  } catch (error: any) {
    core.setFailed(error.message)
  }
}

//
// Call the main task run function
//
run()

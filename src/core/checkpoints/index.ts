import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import type { ClineApiReqInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"

import { getWorkspacePath } from "../../utils/path"
import { checkGitInstalled } from "../../utils/git"
import { t } from "../../i18n"

import { getApiMetrics } from "../../shared/getApiMetrics"

import { DIFF_VIEW_URI_SCHEME } from "../../integrations/editor/DiffViewProvider"

import { CheckpointServiceOptions, RepoPerTaskCheckpointService } from "../../services/checkpoints"

const WARNING_THRESHOLD_MS = 5000

/**
 * Maximum number of consecutive checkpoint operation failures before
 * permanently disabling checkpoints for the task. This prevents a
 * single transient error (e.g., git lock file, temp disk issue) from
 * permanently bricking the checkpoint system, while still disabling
 * after repeated failures that indicate a systemic problem.
 */
export const MAX_CONSECUTIVE_FAILURES = 3

function sendCheckpointInitWarn(task: Task, type?: "WAIT_TIMEOUT" | "INIT_TIMEOUT", timeout?: number) {
	task.providerRef.deref()?.postMessageToWebview({
		type: "checkpointInitWarning",
		checkpointWarning: type && timeout ? { type, timeout } : undefined,
	})
}

/**
 * Track a transient checkpoint failure. Returns true if checkpoints
 * should be permanently disabled (i.e., we've exceeded the max
 * consecutive failure threshold).
 */
function trackCheckpointFailure(task: Task): boolean {
	task.checkpointFailureCount++

	if (task.checkpointFailureCount >= MAX_CONSECUTIVE_FAILURES) {
		console.error(
			`[checkpoints] ${task.checkpointFailureCount} consecutive failures, permanently disabling checkpoints for task ${task.taskId}`,
		)
		task.enableCheckpoints = false
		return true
	}

	return false
}

/**
 * Reset the consecutive failure counter after a successful operation.
 */
function resetCheckpointFailureCount(task: Task) {
	task.checkpointFailureCount = 0
}

export async function getCheckpointService(task: Task, { interval = 250 }: { interval?: number } = {}) {
	if (!task.enableCheckpoints) {
		return undefined
	}

	if (task.checkpointService) {
		return task.checkpointService
	}

	const provider = task.providerRef.deref()

	// Get checkpoint timeout from task settings (converted to milliseconds)
	const checkpointTimeoutMs = task.checkpointTimeout * 1000

	const log = (message: string) => {
		console.log(message)

		try {
			provider?.log(message)
		} catch (err) {
			// NO-OP
		}
	}

	console.log("[Task#getCheckpointService] initializing checkpoints service")

	try {
		const workspaceDir = task.cwd || getWorkspacePath()

		if (!workspaceDir) {
			log("[Task#getCheckpointService] workspace folder not found, disabling checkpoints")
			task.enableCheckpoints = false
			return undefined
		}

		const globalStorageDir = provider?.context.globalStorageUri.fsPath

		if (!globalStorageDir) {
			log("[Task#getCheckpointService] globalStorageDir not found, disabling checkpoints")
			task.enableCheckpoints = false
			return undefined
		}

		const options: CheckpointServiceOptions = {
			taskId: task.taskId,
			workspaceDir,
			shadowDir: globalStorageDir,
			log,
		}

		if (task.checkpointServiceInitializing) {
			const checkpointInitStartTime = Date.now()
			let warningShown = false

			await pWaitFor(
				() => {
					const elapsed = Date.now() - checkpointInitStartTime

					// Show warning if we're past the threshold and haven't shown it yet
					if (!warningShown && elapsed >= WARNING_THRESHOLD_MS) {
						warningShown = true
						sendCheckpointInitWarn(task, "WAIT_TIMEOUT", WARNING_THRESHOLD_MS / 1000)
					}

					console.log(
						`[Task#getCheckpointService] waiting for service to initialize (${Math.round(elapsed / 1000)}s)`,
					)
					return !!task.checkpointService && !!task?.checkpointService?.isInitialized
				},
				{ interval, timeout: checkpointTimeoutMs },
			)
			if (!task?.checkpointService) {
				sendCheckpointInitWarn(task, "INIT_TIMEOUT", task.checkpointTimeout)
				task.enableCheckpoints = false
				return undefined
			} else {
				sendCheckpointInitWarn(task)
			}
			return task.checkpointService
		}

		if (!task.enableCheckpoints) {
			return undefined
		}

		const service = RepoPerTaskCheckpointService.create(options)
		task.checkpointServiceInitializing = true
		await checkGitInstallation(task, service, log, provider)

		// Only assign the service if initialization succeeded (checkGitInstallation
		// resets checkpointServiceInitializing on failure to allow retries)
		if (task.enableCheckpoints && !task.checkpointService) {
			task.checkpointService = service
			sendCheckpointInitWarn(task)
		}
		return task.checkpointService
	} catch (err) {
		if (err.name === "TimeoutError" && task.enableCheckpoints) {
			sendCheckpointInitWarn(task, "INIT_TIMEOUT", task.checkpointTimeout)
			// Timeout during init is a permanent failure for this attempt
			task.enableCheckpoints = false
		} else {
			// For non-timeout errors, use failure tracking to allow retries
			trackCheckpointFailure(task)
		}
		log(`[Task#getCheckpointService] ${err.message}`)
		task.checkpointService = undefined
		task.checkpointServiceInitializing = false
		return undefined
	}
}

async function checkGitInstallation(
	task: Task,
	service: RepoPerTaskCheckpointService,
	log: (message: string) => void,
	provider: any,
) {
	try {
		const gitInstalled = await checkGitInstalled()

		if (!gitInstalled) {
			log("[Task#getCheckpointService] Git is not installed, disabling checkpoints")
			task.enableCheckpoints = false
			task.checkpointServiceInitializing = false

			// Show user-friendly notification
			const selection = await vscode.window.showWarningMessage(
				t("common:errors.git_not_installed"),
				t("common:buttons.learn_more"),
			)

			if (selection === t("common:buttons.learn_more")) {
				await vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"))
			}

			return
		}

		// Git is installed, proceed with initialization
		service.on("initialize", () => {
			log("[Task#getCheckpointService] service initialized")
			task.checkpointServiceInitializing = false
		})

		service.on("checkpoint", ({ fromHash: from, toHash: to, suppressMessage }) => {
			try {
				sendCheckpointInitWarn(task)
				// Always update the current checkpoint hash in the webview, including the suppress flag
				provider?.postMessageToWebview({
					type: "currentCheckpointUpdated",
					text: to,
					suppressMessage: !!suppressMessage,
				})

				// Always create the chat message but include the suppress flag in the payload
				// so the chatview can choose not to render it while keeping it in history.
				task.say(
					"checkpoint_saved",
					to,
					undefined,
					undefined,
					{ from, to, suppressMessage: !!suppressMessage },
					undefined,
					{ isNonInteractive: true },
				).catch((err) => {
					log("[Task#getCheckpointService] caught unexpected error in say('checkpoint_saved')")
					console.error(err)
				})
			} catch (err) {
				// Don't disable checkpoints for notification errors - the checkpoint itself was saved successfully.
				log("[Task#getCheckpointService] caught unexpected error in on('checkpoint') event handler")
				console.error(err)
			}
		})

		log("[Task#getCheckpointService] initializing shadow git")

		try {
			await service.initShadowGit()
		} catch (err) {
			log(`[Task#getCheckpointService] initShadowGit -> ${err.message}`)
			// Reset state to allow re-initialization on next attempt instead of permanently disabling.
			// The shadow git init may fail due to transient issues (lock files, disk space, etc.).
			task.checkpointService = undefined
			task.checkpointServiceInitializing = false
			trackCheckpointFailure(task)
		}
	} catch (err) {
		log(`[Task#getCheckpointService] Unexpected error during Git check: ${err.message}`)
		console.error("Git check error:", err)
		task.checkpointService = undefined
		task.checkpointServiceInitializing = false
		trackCheckpointFailure(task)
	}
}

export async function checkpointSave(task: Task, force = false, suppressMessage = false) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	TelemetryService.instance.captureCheckpointCreated(task.taskId)

	// Start the checkpoint process in the background.
	return service
		.saveCheckpoint(`Task: ${task.taskId}, Time: ${Date.now()}`, { allowEmpty: force, suppressMessage })
		.then((result) => {
			resetCheckpointFailureCount(task)
			return result
		})
		.catch((err) => {
			console.error("[Task#checkpointSave] caught unexpected error during checkpoint save", err)
			trackCheckpointFailure(task)
		})
}

export type CheckpointRestoreOptions = {
	ts: number
	commitHash: string
	mode: "preview" | "restore"
	operation?: "delete" | "edit" // Optional to maintain backward compatibility
}

export async function checkpointRestore(
	task: Task,
	{ ts, commitHash, mode, operation = "delete" }: CheckpointRestoreOptions,
) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	const index = task.clineMessages.findIndex((m) => m.ts === ts)

	if (index === -1) {
		return
	}

	const provider = task.providerRef.deref()

	try {
		await service.restoreCheckpoint(commitHash)
		TelemetryService.instance.captureCheckpointRestored(task.taskId)
		resetCheckpointFailureCount(task)
		await provider?.postMessageToWebview({ type: "currentCheckpointUpdated", text: commitHash })

		if (mode === "restore") {
			// Calculate metrics from messages that will be deleted (must be done before rewind)
			const deletedMessages = task.clineMessages.slice(index + 1)

			const { totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, totalCost } = getApiMetrics(
				task.combineMessages(deletedMessages),
			)

			// Use MessageManager to properly handle context-management events
			// This ensures orphaned Summary messages and truncation markers are cleaned up
			await task.messageManager.rewindToTimestamp(ts, {
				includeTargetMessage: operation === "edit",
			})

			// Report the deleted API request metrics
			await task.say(
				"api_req_deleted",
				JSON.stringify({
					tokensIn: totalTokensIn,
					tokensOut: totalTokensOut,
					cacheWrites: totalCacheWrites,
					cacheReads: totalCacheReads,
					cost: totalCost,
				} satisfies ClineApiReqInfo),
			)
		}

		// The task is already cancelled by the provider beforehand, but we
		// need to re-init to get the updated messages.
		//
		// This was taken from Cline's implementation of the checkpoints
		// feature. The task instance will hang if we don't cancel twice,
		// so this is currently necessary, but it seems like a complicated
		// and hacky solution to a problem that I don't fully understand.
		// I'd like to revisit this in the future and try to improve the
		// task flow and the communication between the webview and the
		// `Task` instance.
		provider?.cancelTask()
	} catch (err) {
		const disabled = trackCheckpointFailure(task)
		provider?.log(
			`[checkpointRestore] checkpoint restore failed${disabled ? ", permanently disabling checkpoints" : ", will retry on next attempt"}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

export type CheckpointDiffOptions = {
	ts?: number
	previousCommitHash?: string
	commitHash: string
	/**
	 * from-init: Compare from the first checkpoint to the selected checkpoint.
	 * checkpoint: Compare the selected checkpoint to the next checkpoint.
	 * to-current: Compare the selected checkpoint to the current workspace.
	 * full: Compare from the first checkpoint to the current workspace.
	 */
	mode: "from-init" | "checkpoint" | "to-current" | "full"
}

export async function checkpointDiff(task: Task, { ts, previousCommitHash, commitHash, mode }: CheckpointDiffOptions) {
	const service = await getCheckpointService(task)

	if (!service) {
		return
	}

	TelemetryService.instance.captureCheckpointDiffed(task.taskId)

	let fromHash: string | undefined
	let toHash: string | undefined
	let title: string

	const checkpoints = task.clineMessages.filter(({ say }) => say === "checkpoint_saved").map(({ text }) => text!)

	if (["from-init", "full"].includes(mode) && checkpoints.length < 1) {
		vscode.window.showInformationMessage(t("common:errors.checkpoint_no_first"))
		return
	}

	const idx = checkpoints.indexOf(commitHash)
	switch (mode) {
		case "checkpoint":
			fromHash = commitHash
			toHash = idx !== -1 && idx < checkpoints.length - 1 ? checkpoints[idx + 1] : undefined
			title = t("common:errors.checkpoint_diff_with_next")
			break
		case "from-init":
			fromHash = checkpoints[0]
			toHash = commitHash
			title = t("common:errors.checkpoint_diff_since_first")
			break
		case "to-current":
			fromHash = commitHash
			toHash = undefined
			title = t("common:errors.checkpoint_diff_to_current")
			break
		case "full":
			fromHash = checkpoints[0]
			toHash = undefined
			title = t("common:errors.checkpoint_diff_since_first")
			break
	}

	if (!fromHash) {
		vscode.window.showInformationMessage(t("common:errors.checkpoint_no_previous"))
		return
	}

	try {
		const changes = await service.getDiff({ from: fromHash, to: toHash })

		if (!changes?.length) {
			vscode.window.showInformationMessage(t("common:errors.checkpoint_no_changes"))
			return
		}

		resetCheckpointFailureCount(task)

		await vscode.commands.executeCommand(
			"vscode.changes",
			title,
			changes.map((change) => [
				vscode.Uri.file(change.paths.absolute),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.before ?? "").toString("base64"),
				}),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${change.paths.relative}`).with({
					query: Buffer.from(change.content.after ?? "").toString("base64"),
				}),
			]),
		)
	} catch (err) {
		const provider = task.providerRef.deref()
		const disabled = trackCheckpointFailure(task)
		provider?.log(
			`[checkpointDiff] checkpoint diff failed${disabled ? ", permanently disabling checkpoints" : ", will retry on next attempt"}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

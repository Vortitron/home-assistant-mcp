/**
 * What the ESPHome build commands are doing right now, for anyone watching.
 *
 * A compile or a flash returns its whole output only when it ends, minutes
 * later, so a watcher (the vome-esphome pane in Claude Code) had nothing to
 * show while it ran. The polling loop already receives the output line by line;
 * this keeps those lines, each with a sequence number, so a reader can ask for
 * just what is new since it last looked (`esphome_activity`).
 *
 * Kept per server context, so a session sees only its own builds. Bounded:
 * the last {@link KEEP_LINES} lines of each job, and finished jobs for
 * {@link KEEP_FINISHED_MS}. Reading never changes anything.
 */

export interface EsphomeJobView {
	job_id: string;
	command: string;
	configuration: string;
	started: string;
	finished: string | null;
	done: boolean;
	exit_code: number | null;
	error: string | null;
	/** Lines this job has produced so far, including any no longer kept. */
	line_count: number;
	/** The kept lines newer than the reader's `since`, oldest first. */
	lines: string[];
}

export interface EsphomeActivitySnapshot {
	/** The newest sequence number; pass it back as `since` to get only what follows. */
	seq: number;
	jobs: EsphomeJobView[];
}

export interface EsphomeActivityLog {
	begin(jobId: string, command: string, configuration: string): void;
	addLines(jobId: string, lines: string[]): void;
	finish(jobId: string, outcome: { exitCode: number | null; error?: string | null }): void;
	snapshot(since?: number): EsphomeActivitySnapshot;
}

const KEEP_LINES = 400;
const KEEP_FINISHED_MS = 10 * 60 * 1000;

interface Job {
	jobId: string;
	command: string;
	configuration: string;
	started: number;
	finished: number | null;
	exitCode: number | null;
	error: string | null;
	lineCount: number;
	lines: { seq: number; text: string }[];
}

export function createEsphomeActivityLog(now: () => number = Date.now): EsphomeActivityLog {
	const jobs = new Map<string, Job>();
	let seq = 0;

	function prune(): void {
		const cutoff = now() - KEEP_FINISHED_MS;
		for (const [id, job] of jobs) {
			if (job.finished !== null && job.finished < cutoff) {
				jobs.delete(id);
			}
		}
	}

	return {
		begin(jobId, command, configuration) {
			prune();
			jobs.set(jobId, {
				jobId,
				command,
				configuration,
				started: now(),
				finished: null,
				exitCode: null,
				error: null,
				lineCount: 0,
				lines: []
			});
			seq += 1;
		},
		addLines(jobId, lines) {
			const job = jobs.get(jobId);
			if (!job || lines.length === 0) {
				return;
			}
			for (const text of lines) {
				seq += 1;
				job.lines.push({ seq, text });
				job.lineCount += 1;
			}
			if (job.lines.length > KEEP_LINES) {
				job.lines.splice(0, job.lines.length - KEEP_LINES);
			}
		},
		finish(jobId, outcome) {
			const job = jobs.get(jobId);
			if (!job) {
				return;
			}
			job.finished = now();
			job.exitCode = outcome.exitCode;
			job.error = outcome.error ?? null;
			seq += 1;
		},
		snapshot(since = 0) {
			prune();
			return {
				seq,
				jobs: [...jobs.values()].map((job) => ({
					job_id: job.jobId,
					command: job.command,
					configuration: job.configuration,
					started: new Date(job.started).toISOString(),
					finished: job.finished === null ? null : new Date(job.finished).toISOString(),
					done: job.finished !== null,
					exit_code: job.exitCode,
					error: job.error,
					line_count: job.lineCount,
					lines: job.lines.filter((line) => line.seq > since).map((line) => line.text)
				}))
			};
		}
	};
}

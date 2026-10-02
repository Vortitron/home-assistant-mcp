/**
 * A build's output, trimmed to what an agent reads it for.
 *
 * A compile prints one "Compiling <file>.o" line per source file, hundreds of
 * them, and every one went into the agent's context: up to 5,000 lines for a
 * build whose story is "it compiled, RAM 11%, Flash 52%" or one error. What an
 * agent needs is the errors and warnings, the memory use, the outcome, and the
 * last lines (where a failure explains itself). Short output is returned whole;
 * `full_output` asks for all of it.
 */

export interface OutputSummary {
	output: string;
	total_lines: number;
	/** True when lines were left out; `full_output: true` returns them. */
	summarised: boolean;
}

const WHOLE_UP_TO = 150;
const KEEP_ISSUES = 60;

// Terminal colour codes, real or written out as text (the dashboard's stream sends `\033[32m`
// as characters). The escape character is built from its code, since lint refuses it raw.
const ANSI = new RegExp(`(${String.fromCharCode(27)}|\\\\033|\\\\x1b|\\\\u001b)\\[[0-9;]*[A-Za-z]`, "g");
const ISSUE = /\[[EW]\]|^(ERROR|WARNING)\b|\b(error|warning):|\*\*\* \[|\bFAILED\b/i;
const MILESTONE = /^(RAM|Flash):\s|Successfully (compiled|uploaded)|OTA successful|Configuration is valid|^INFO (Reading|Uploading|Successfully)/;

export function summariseOutput(output: string, tail: number): OutputSummary {
	const lines = output.replace(ANSI, "").split("\n").map((line) => {
		// A progress bar redraws itself with carriage returns; keep its last state.
		const parts = line.split("\r").filter((part) => part.trim() !== "");
		return (parts.at(-1) ?? "").trimEnd();
	}).filter((line) => line !== "");
	if (lines.length <= WHOLE_UP_TO) {
		return { output, total_lines: lines.length, summarised: false };
	}

	const head = lines.slice(0, lines.length - tail);
	const issues = [...new Set(head.filter((line) => ISSUE.test(line) && !/\b0 errors?\b/i.test(line)))];
	const milestones = head.filter((line) => MILESTONE.test(line));
	const shownIssues = issues.slice(0, KEEP_ISSUES);
	const kept = [
		...(shownIssues.length > 0 ? ["── errors and warnings ──", ...shownIssues] : []),
		...(issues.length > shownIssues.length ? [`(${issues.length - shownIssues.length} more errors and warnings)`] : []),
		...(milestones.length > 0 ? ["── milestones ──", ...milestones] : []),
		`── ${head.length} earlier lines left out (full_output: true returns them) ──`,
		...lines.slice(-tail)
	];
	return { output: `${kept.join("\n")}\n`, total_lines: lines.length, summarised: true };
}

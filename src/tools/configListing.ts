/**
 * Shaping one folder listing from the home's Vome component for an agent:
 * a glob filter, paging, totals, and a plain statement of what the listing
 * cannot tell you.
 *
 * The component (`relay_client.py` `_list_dir` in VomeSync) returns one
 * directory, folders first then files A–Z, and stops at 500 entries with
 * `truncated: true`. It takes nothing but `?path=`, so everything here works
 * on what that one listing returned: it cannot page past the 500th entry or
 * size a subfolder. Those would need the component to change.
 */

export interface ListingEntry {
	name: string;
	path: string;
	is_dir: boolean;
	size: number | null;
	[key: string]: unknown;
}

export interface ComponentListing {
	path?: string;
	entries?: ListingEntry[];
	truncated?: boolean;
	[key: string]: unknown;
}

export const DEFAULT_LIST_LIMIT = 200;
/** The component's own cap on one listing (FILES_MAX_ENTRIES). */
export const COMPONENT_MAX_ENTRIES = 500;

/**
 * A shell-style glob as a regular expression, matched case-insensitively.
 *
 * `*` and `?` stay within one path segment, `**` crosses segments (`**\/`
 * also matches nothing, so `**\/*.yaml` matches `a.yaml`), and `{a,b}` is an
 * alternation. Everything else is literal: there is no character-class or
 * extglob syntax, which keeps a caller's pattern from ever becoming a costly
 * or surprising regex. No dependency needed for that much.
 */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	let braceDepth = 0;
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else if (ch === "{") {
			braceDepth++;
			out += "(?:";
		} else if (ch === "}" && braceDepth > 0) {
			braceDepth--;
			out += ")";
		} else if (ch === "," && braceDepth > 0) {
			out += "|";
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	out += ")".repeat(braceDepth);
	return new RegExp(`^${out}$`, "i");
}

/**
 * Whether an entry matches. A pattern with no `/` is matched against the
 * entry's name, as `ls *.yaml` would; one with a `/` against its path from
 * the config root or from the folder being listed.
 */
export function entryMatches(entry: ListingEntry, pattern: RegExp, hasSlash: boolean, folder: string): boolean {
	if (!hasSlash) {
		return pattern.test(entry.name);
	}
	const prefix = folder ? `${folder.replace(/\/+$/, "")}/` : "";
	const relative = prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
	return pattern.test(entry.path) || pattern.test(relative);
}

export interface ListingOptions {
	glob?: string;
	offset?: number;
	limit?: number;
}

export function shapeListing(listing: ComponentListing, requestedPath: string, options: ListingOptions): Record<string, unknown> {
	const entries = Array.isArray(listing?.entries) ? listing.entries : [];
	const folder = typeof listing?.path === "string" ? listing.path : requestedPath;
	const files = entries.filter((entry) => !entry.is_dir);
	const bytesOf = (list: ListingEntry[]): number =>
		list.reduce((sum, entry) => sum + (typeof entry.size === "number" && !entry.is_dir ? entry.size : 0), 0);

	const glob = options.glob?.trim() || undefined;
	const matched = glob
		? entries.filter((entry) => entryMatches(entry, globToRegExp(glob), glob.includes("/"), folder))
		: entries;
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT);
	const page = matched.slice(offset, offset + limit);
	const nextOffset = offset + page.length;
	const truncated = listing?.truncated === true;

	const notes: string[] = [
		"total_bytes is the size of this folder's own files only; subfolders are not counted. " +
			"List a subfolder to size it."
	];
	if (truncated) {
		notes.unshift(
			`The home returned only the first ${COMPONENT_MAX_ENTRIES} entries of this folder (folders first, ` +
				"then files A-Z), so files later in the alphabet are missing, and total_entries and total_bytes " +
				"undercount. List a subfolder instead; offset/limit only page through what the home returned."
		);
	}
	if (glob && matched.length === 0 && entries.length > 0) {
		notes.push(`Nothing in this folder matches '${glob}'. The glob applies to this one folder; it does not search subfolders.`);
	}

	return {
		path: folder,
		total_entries: entries.length,
		files: files.length,
		folders: entries.length - files.length,
		total_bytes: bytesOf(files),
		truncated,
		...(glob ? { glob, matched: matched.length, matched_bytes: bytesOf(matched) } : {}),
		offset,
		returned: page.length,
		has_more: nextOffset < matched.length,
		...(nextOffset < matched.length ? { next_offset: nextOffset } : {}),
		note: notes.join(" "),
		entries: page
	};
}

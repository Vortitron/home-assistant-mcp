import { describe, expect, it } from "vitest";
import { globToRegExp, shapeListing, type ListingEntry } from "../src/tools/configListing.js";

const file = (path: string, size: number): ListingEntry => ({
	name: path.split("/").pop() as string,
	path,
	is_dir: false,
	size
});
const dir = (path: string): ListingEntry => ({ name: path.split("/").pop() as string, path, is_dir: true, size: null });

describe("globToRegExp", () => {
	it("keeps * and ? inside one segment and lets ** cross them", () => {
		expect(globToRegExp("*.yaml").test("automations.yaml")).toBe(true);
		expect(globToRegExp("*.yaml").test("packages/a.yaml")).toBe(false);
		expect(globToRegExp("?.yaml").test("a.yaml")).toBe(true);
		expect(globToRegExp("**/*.html").test("www/cards/x.html")).toBe(true);
		expect(globToRegExp("**/*.html").test("x.html")).toBe(true);
		expect(globToRegExp("www/**").test("www/a/b.js")).toBe(true);
	});

	it("supports {a,b}, ignores case, and treats regex characters literally", () => {
		expect(globToRegExp("*.{yaml,yml}").test("x.YML")).toBe(true);
		expect(globToRegExp("*.{yaml,yml}").test("x.json")).toBe(false);
		expect(globToRegExp("a+b(1).txt").test("a+b(1).txt")).toBe(true);
		expect(globToRegExp("a.txt").test("abtxt")).toBe(false);
		expect(globToRegExp("[ab].txt").test("a.txt")).toBe(false);
		expect(globToRegExp("[ab].txt").test("[ab].txt")).toBe(true);
	});
});

describe("shapeListing", () => {
	const listing = {
		path: "www",
		truncated: false,
		entries: [dir("www/community"), file("www/a.html", 100), file("www/b.js", 50), file("www/c.HTML", 25)]
	};

	it("totals this folder's own files and says subfolders are not counted", () => {
		const out = shapeListing(listing, "www", {});
		expect(out).toMatchObject({ path: "www", total_entries: 4, files: 3, folders: 1, total_bytes: 175, truncated: false });
		expect(out.note).toMatch(/subfolders are not counted/);
		expect(out.has_more).toBe(false);
	});

	it("filters by name, or by path when the glob has a slash", () => {
		const byName = shapeListing(listing, "www", { glob: "*.html" });
		expect((byName.entries as ListingEntry[]).map((e) => e.name)).toEqual(["a.html", "c.HTML"]);
		expect(byName).toMatchObject({ matched: 2, matched_bytes: 125, total_bytes: 175 });

		const byPath = shapeListing(listing, "www", { glob: "www/*.js" });
		expect((byPath.entries as ListingEntry[]).map((e) => e.name)).toEqual(["b.js"]);
		const relative = shapeListing(listing, "www", { glob: "**/*.js" });
		expect(relative.matched).toBe(1);
	});

	it("pages with offset and limit and hands back next_offset", () => {
		const first = shapeListing(listing, "www", { limit: 3 });
		expect(first).toMatchObject({ returned: 3, has_more: true, next_offset: 3 });
		const second = shapeListing(listing, "www", { offset: 3, limit: 3 });
		expect(second).toMatchObject({ returned: 1, has_more: false });
		expect(second.next_offset).toBeUndefined();
	});

	it("explains a truncated folder instead of passing the flag on silently", () => {
		const entries = Array.from({ length: 500 }, (_, i) => file(`www/f${i}.js`, 10));
		const out = shapeListing({ path: "www", entries, truncated: true }, "www", {});
		expect(out.truncated).toBe(true);
		expect(out.total_entries).toBe(500);
		expect(out.returned).toBe(200);
		expect(out.note).toMatch(/only the first 500 entries/);
		expect(out.note).toMatch(/List a subfolder/);
	});
});

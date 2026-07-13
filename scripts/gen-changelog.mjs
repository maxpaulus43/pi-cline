#!/usr/bin/env node
// Generates a changelog entry for the version being released.
// Runs as a pre-commit hook. Only acts when the staged package.json
// version differs from HEAD (i.e. a release bump).
//
// Calls a local LMStudio instance (OpenAI-compatible API) to summarize
// commit subjects and diffs into a Markdown bullet list. If LMStudio is unreachable,
// falls back to the raw commit subjects so the release always gets an entry.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CHANGELOG_PATH = "CHANGELOG.md";
const CHANGELOG_HEADER = "# Changelog\n\n";
const MAINTENANCE_ENTRY = "- Maintenance and internal improvements.";

const LMSTUDIO_URL = "http://localhost:1234";
const MODEL = ""; // empty = auto-detect the first loaded model
const TIMEOUT_MS = 90_000;

await main();

async function main() {
    const release = getReleaseVersion();
    if (!release) return;

    console.log(`[changelog] version bump ${release.previous} -> ${release.next}`);

    const previousTag = getPreviousTag();
    const commits = [...getCommitSubjects(previousTag), getStagedCommitSubject()].filter(Boolean);
    const changelogSource = changelogWorthy(commits);
    const changelogContext = [
        `Commit subjects:\n${changelogSource}`,
        `Committed diff:\n${getCommitDiff(previousTag)}`,
        `Staged diff:\n${getStagedDiff()}`,
    ].join("\n\n");

    console.log(`[changelog] ${commits.length} commit(s), including staged commit, since ${previousTag ?? "start"}`);

    const summary = await summarizeOrFallback(changelogContext, changelogSource);
    const entry = formatEntry(release.next, summary);

    prependChangelogEntry(entry);
    git(["add", CHANGELOG_PATH]);

    console.log(`[changelog] added ${release.next} entry to ${CHANGELOG_PATH}`);
}

function getReleaseVersion() {
    const next = packageVersionFromGit(":package.json");
    const previous = packageVersionFromGit("HEAD:package.json");

    if (!next || !previous || next === previous) return null;
    return { previous, next };
}

function packageVersionFromGit(ref) {
    try {
        return JSON.parse(git(["show", ref])).version;
    } catch {
        return null;
    }
}

function getPreviousTag() {
    try {
        return git(["describe", "--tags", "--abbrev=0"]);
    } catch {
        return null;
    }
}

function getCommitSubjects(previousTag) {
    const range = previousTag ? [`${previousTag}..HEAD`] : [];
    const order = previousTag ? [] : ["--reverse"];
    const output = git(["log", ...order, "--pretty=format:- %s", ...range]);

    return output.split("\n").filter(Boolean);
}

function getCommitDiff(previousTag) {
    const range = previousTag ? [`${previousTag}..HEAD`] : ["--root", "HEAD"];
    return git(["diff", ...range]);
}

function getStagedDiff() {
    return git(["diff", "--cached"]);
}

function getStagedCommitSubject() {
    try {
        const commitMessagePath = git(["rev-parse", "--git-path", "COMMIT_EDITMSG"]);
        const message = readFileSync(commitMessagePath, "utf8");
        return message.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
    } catch {
        return "";
    }
}

function changelogWorthy(commits) {
    const meaningful = commits.filter((subject) => !/^-\s*bump\b/i.test(subject));
    const subjects = meaningful.length ? meaningful : commits;

    return subjects.join("\n") || MAINTENANCE_ENTRY;
}

async function summarizeOrFallback(context, fallback) {
    try {
        return await summarize(context);
    } catch (error) {
        console.error(`[changelog] LMStudio unreachable (${error.message}); using raw commit list.`);
        return fallback;
    }
}

function formatEntry(version, summary) {
    const today = new Date().toISOString().slice(0, 10);
    return `## ${version} - ${today}\n${summary}\n`;
}

function prependChangelogEntry(entry) {
    const existing = existsSync(CHANGELOG_PATH) ? readFileSync(CHANGELOG_PATH, "utf8") : "";
    const body = existing.startsWith(CHANGELOG_HEADER)
        ? existing.slice(CHANGELOG_HEADER.length)
        : existing.replace(/^#\s*Changelog.*\n+/, "");

    writeFileSync(CHANGELOG_PATH, CHANGELOG_HEADER + entry + body);
}

async function summarize(commits) {
    const model = MODEL || (await detectModel());

    console.log(`[changelog] summarizing with ${model} (may take a moment)...`);

    const response = await fetchWithTimeout(`${LMSTUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            temperature: 0.3,
            messages: [
                { role: "system", content: changelogPrompt() },
                { role: "user", content: commits },
            ],
        }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) throw new Error("empty response");
    return text;
}

async function detectModel() {
    console.log("[changelog] resolving LMStudio model...");

    const response = await fetchWithTimeout(`${LMSTUDIO_URL}/v1/models`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const model = data.data?.[0]?.id;

    if (!model) throw new Error("no model loaded in LMStudio");
    return model;
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === "AbortError") throw new Error("request timed out");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function changelogPrompt() {
    return [
        "You write concise changelog entries for a software package.",
        "Output ONLY a Markdown bullet list of user-facing changes.",
        "No headers, no version line, no preamble, no code fences.",
        "One bullet per logical change, present-tense imperative.",
        "Max 6 bullets. Omit chores such as version bumps.",
        `If nothing user-facing, output: ${MAINTENANCE_ENTRY}`,
    ].join(" ");
}

function git(args) {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
}

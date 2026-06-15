#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_DIR = "C:\\tmp\\x-followback-audit-browser-profile";

function parseArgs(argv) {
	const args = {
		login: false,
		maxScrolls: 500,
		scrollPauseMs: 900,
		bottomRetries: 30,
		out: "x_followback_audit.json",
		profileDir: DEFAULT_PROFILE_DIR,
		port: 9233,
		exporter: join(SCRIPT_DIR, "export_followback_audit.py"),
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--login") args.login = true;
		else if (arg === "--max-scrolls") args.maxScrolls = Number(argv[++i] || args.maxScrolls);
		else if (arg === "--scroll-pause-ms") args.scrollPauseMs = Number(argv[++i] || args.scrollPauseMs);
		else if (arg === "--bottom-retries") args.bottomRetries = Number(argv[++i] || args.bottomRetries);
		else if (arg === "--out") args.out = argv[++i] || args.out;
		else if (arg === "--profile-dir") args.profileDir = argv[++i] || args.profileDir;
		else if (arg === "--port") args.port = Number(argv[++i] || args.port);
		else if (arg === "--exporter") args.exporter = argv[++i] || args.exporter;
	}
	return args;
}

function findChrome() {
	const env = process.env;
	const candidates = [
		env.CHROME_PATH,
		join(env.ProgramFiles || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
		join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
		join(env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
		join(env.ProgramFiles || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
		join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("Chrome/Edge not found. Set CHROME_PATH and retry.");
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return response.json();
}

async function waitForPageEndpoint(port) {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		try {
			const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
			const page =
				targets.find((target) => target.type === "page" && String(target.url || "").includes("x.com")) ||
				targets.find((target) => target.type === "page");
			if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		} catch {
			await sleep(500);
		}
	}
	throw new Error("Chrome DevTools page endpoint did not become ready.");
}

function cdpClient(wsUrl) {
	let nextId = 1;
	const pending = new Map();
	const ws = new WebSocket(wsUrl);
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (!message.id || !pending.has(message.id)) return;
		const p = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) p.reject(new Error(message.error.message || JSON.stringify(message.error)));
		else p.resolve(message.result || {});
	});
	return new Promise((resolve, reject) => {
		ws.addEventListener("open", () => {
			resolve({
				send(method, params = {}) {
					const id = nextId++;
					ws.send(JSON.stringify({ id, method, params }));
					return new Promise((ok, fail) => pending.set(id, { resolve: ok, reject: fail }));
				},
				close() {
					ws.close();
				},
			});
		});
		ws.addEventListener("error", reject);
	});
}

async function evalJs(client, expression, awaitPromise = false) {
	const result = await withTimeout(
		client.send("Runtime.evaluate", {
			expression,
			awaitPromise,
			returnByValue: true,
		}),
		15_000,
		"Runtime.evaluate timed out",
	);
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
	return result.result?.value;
}

function withTimeout(promise, ms, message) {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]);
}

async function waitForLogin(client) {
	let loops = 0;
	for (;;) {
		const loggedIn = await evalJs(
			client,
			`Boolean(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], [data-testid="AppTabBar_Home_Link"]'))`,
		).catch(() => false);
		if (loggedIn) return;
		loops += 1;
		if (loops % 15 === 0) console.error("Waiting for X login in the opened browser...");
		await sleep(2000);
	}
}

async function currentHandle(client) {
	const profileUrl = await evalJs(
		client,
		`(() => document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.href || "")()`,
	).catch(() => "");
	if (!profileUrl) return "";
	return new URL(profileUrl).pathname.replace(/^\//, "").replace(/\/$/, "");
}

function parseVisibleCount(raw) {
	const text = String(raw || "").replace(/,/g, "").trim();
	const match = text.match(/(\d+(?:\.\d+)?)\s*([KMB\u4e07\u4ebf]?)/i);
	if (!match) return null;
	const value = Number(match[1]);
	const suffix = (match[2] || "").toUpperCase();
	if (!Number.isFinite(value)) return null;
	if (suffix === "K") return Math.round(value * 1000);
	if (suffix === "M") return Math.round(value * 1_000_000);
	if (suffix === "B") return Math.round(value * 1_000_000_000);
	if (suffix === "\u4e07") return Math.round(value * 10_000);
	if (suffix === "\u4ebf") return Math.round(value * 100_000_000);
	return Math.round(value);
}

async function readFollowingCount(client) {
	const text = await evalJs(
		client,
		`(() => {
			const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
			const links = Array.from(document.querySelectorAll('main a[href]'));
			const following = links.find((a) => /\\/following$/.test(a.getAttribute("href") || ""));
			return textOf(following);
		})()`,
	).catch(() => "");
	return parseVisibleCount(text);
}

function collectVisibleFollowingRowsExpression() {
	return `(() => {
		const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
		const handleOf = (text) => {
			const match = String(text || "").match(/@[A-Za-z0-9_]{1,15}/);
			return match ? match[0] : "";
		};
		const primary = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector("main") || document;
		return Array.from(primary.querySelectorAll('[data-testid="UserCell"]')).map((cell) => {
			const raw = textOf(cell);
			const handle = handleOf(raw) || handleOf(textOf(cell.querySelector('a[href^="/"]')));
			if (!handle) return null;
			const indicator = textOf(cell.querySelector('[data-testid="userFollowIndicator"]'));
			const followsYou = /follows you|\\u5173\\u6ce8\\u4e86\\u4f60|\\u95dc\\u6ce8\\u4e86\\u4f60/i.test(indicator);
			return {
				handle,
				relationship: followsYou ? "mutual" : "not_following_back",
				blue_verified: Boolean(cell.querySelector('[data-testid="icon-verified"]')),
			};
		}).filter(Boolean);
	})()`;
}

async function readScrollState(client) {
	return evalJs(
		client,
		`(() => {
			const el = document.scrollingElement || document.documentElement || document.body;
			const top = el?.scrollTop || window.scrollY || 0;
			const height = el?.scrollHeight || document.body?.scrollHeight || 0;
			const clientHeight = el?.clientHeight || window.innerHeight || 0;
			const remaining = Math.max(0, height - clientHeight - top);
			return {
				top: Math.round(top),
				height: Math.round(height),
				remaining: Math.round(remaining),
				isBottom: height > 0 && remaining <= 80,
			};
		})()`,
	).catch(() => ({ top: null, height: null, remaining: null, isBottom: false }));
}

async function wheelDown(client, bursts = 1) {
	for (let i = 0; i < Math.max(1, bursts); i += 1) {
		await withTimeout(
			client
			.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: 600,
				y: 700,
				deltaX: 0,
				deltaY: 1700,
				pointerType: "mouse",
			})
			.catch(() => {}),
			8_000,
			"mouseWheel timed out",
		).catch(() => {});
		await sleep(80);
	}
	await evalJs(
		client,
		`(() => {
			const amount = Math.round(window.innerHeight * 1.8);
			window.scrollBy(0, amount);
			const el = document.scrollingElement || document.documentElement || document.body;
			if (el && typeof el.scrollBy === "function") el.scrollBy(0, amount);
			return true;
		})()`,
	).catch(() => {});
}

async function nudgeAndWheelDown(client) {
	await withTimeout(
		evalJs(
			client,
			`(() => {
				const amount = Math.round(window.innerHeight * 0.7);
				window.scrollBy(0, -amount);
				const el = document.scrollingElement || document.documentElement || document.body;
				if (el && typeof el.scrollBy === "function") el.scrollBy(0, -amount);
				return true;
			})()`,
		).catch(() => {}),
		8_000,
		"nudge scroll timed out",
	).catch(() => {});
	await sleep(250);
	await wheelDown(client, 3);
}

function jsonPath(outArg) {
	const path = resolve(outArg);
	return path.toLowerCase().endsWith(".json") ? path : resolve(`${outArg}.json`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const profileDir = resolve(args.profileDir);
	mkdirSync(profileDir, { recursive: true });

	console.error(`Starting X follow-back audit on port ${args.port}`);
	const child = spawn(
		findChrome(),
		[
			`--remote-debugging-port=${args.port}`,
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--new-window",
			"https://x.com/home",
		],
		{ detached: true, stdio: "ignore", windowsHide: false },
	);
	child.unref();

	const client = await cdpClient(await waitForPageEndpoint(args.port));
	await client.send("Runtime.enable").catch(() => {});
	await client.send("Page.enable").catch(() => {});

	if (args.login) await waitForLogin(client);
	await withTimeout(client.send("Page.navigate", { url: "https://x.com/home" }), 15_000, "navigate home timed out").catch(() => {});
	await sleep(3500);

	const handle = await currentHandle(client);
	if (!handle) throw new Error("Could not identify the logged-in X account.");
	console.error(`Logged-in account: @${handle}`);

	await withTimeout(client.send("Page.navigate", { url: `https://x.com/${handle}` }), 15_000, "navigate profile timed out").catch(() => {});
	await sleep(3500);
	const expectedFollowing = await readFollowingCount(client);
	console.error(`Profile following count: ${expectedFollowing ?? "unknown"}`);

	await withTimeout(client.send("Page.navigate", { url: `https://x.com/${handle}/following` }), 15_000, "navigate following timed out").catch(() => {});
	await sleep(5500);

	const seen = new Map();
	let lastSize = -1;
	let noNewAfterWheel = 0;
	let bottomRetryCount = 0;
	let bottomMode = false;
	let lastBottomTop = null;
	let stableBottomCount = 0;
	for (let i = 0; i < Math.max(1, args.maxScrolls); i += 1) {
		const rows = (await evalJs(client, collectVisibleFollowingRowsExpression())) || [];
		for (const row of rows) {
			if (!seen.has(row.handle)) seen.set(row.handle, row);
		}

		const scrollState = await withTimeout(readScrollState(client), 10_000, "readScrollState timed out").catch(() => ({ top: null, height: null, remaining: null, isBottom: false }));
		const added = seen.size - Math.max(lastSize, 0);
		lastSize = seen.size;
		noNewAfterWheel = added > 0 ? 0 : noNewAfterWheel + 1;
		if (added > 0) {
			bottomMode = false;
			bottomRetryCount = 0;
			stableBottomCount = 0;
			lastBottomTop = null;
		}
		if (scrollState.isBottom && added <= 0) {
			if (lastBottomTop !== null && scrollState.top !== null && Math.abs(scrollState.top - lastBottomTop) <= 5) {
				stableBottomCount += 1;
			} else {
				stableBottomCount = 1;
			}
			lastBottomTop = scrollState.top;
		}
		console.error(
			`Scan ${i + 1}/${args.maxScrolls}: seen=${seen.size}, added=${Math.max(0, added)}, bottom=${scrollState.isBottom}, remaining=${scrollState.remaining ?? "unknown"}`,
		);

		if (expectedFollowing !== null && seen.size >= expectedFollowing) break;
		if (scrollState.isBottom) {
			bottomMode = true;
			bottomRetryCount += 1;
			const targetText = expectedFollowing === null ? "unknown" : String(expectedFollowing);
			console.error(
				`Bottom retry ${bottomRetryCount}/${args.bottomRetries}: target=${targetText}, seen=${seen.size}, stableBottom=${stableBottomCount}`,
			);
			if (bottomRetryCount >= Math.max(1, args.bottomRetries) || stableBottomCount >= 3) break;
			await nudgeAndWheelDown(client);
			await sleep(Math.max(500, args.scrollPauseMs));
			continue;
		}
		if (bottomMode && noNewAfterWheel >= 3) {
			console.error(`Bottom mode exit: no new rows after ${noNewAfterWheel} scroll attempts, seen=${seen.size}`);
			break;
		}

		await wheelDown(client, noNewAfterWheel >= 2 ? 2 : 1);
		await sleep(Math.max(250, args.scrollPauseMs));
	}

	const rows = [...seen.values()];
	const notFollowingBack = rows.filter((row) => row.relationship === "not_following_back");
	console.error(`Collected following rows: ${rows.length}`);
	console.error(`Not following back: ${notFollowingBack.length}`);
	if (expectedFollowing !== null && rows.length < expectedFollowing) {
		console.error(`Incomplete scan gap: expected=${expectedFollowing}, seen=${rows.length}, gap=${expectedFollowing - rows.length}`);
	}

	const outJson = jsonPath(args.out);
	writeFileSync(outJson, `${JSON.stringify({ rows: notFollowingBack }, null, 2)}\n`, "utf8");
	const exportResult = spawnSync(process.env.PYTHON || "py", ["-3", resolve(args.exporter), "--input", outJson], {
		encoding: "utf8",
		stdio: "pipe",
	});
	if (exportResult.status !== 0) {
		process.stderr.write(exportResult.stdout || "");
		process.stderr.write(exportResult.stderr || "");
		throw new Error(`Export failed with exit code ${exportResult.status}`);
	}
	process.stdout.write(exportResult.stdout || "");
	rmSync(outJson, { force: true });
	client.close();
}

main().catch((error) => {
	console.error(`Error: ${error.message}`);
	process.exit(1);
});

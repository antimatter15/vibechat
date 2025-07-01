#!/usr/bin/env node
import React, { useState, useEffect, useRef } from "react";
import {
	render,
	Box,
	Text,
	useInput,
	useApp,
	Static,
	useStdout,
	measureElement,
} from "ink";
import chalk from "chalk";

const TextInput = ({
	value: originalValue = "",
	placeholder = "",
	focus = true,
	onChange,
	onSubmit,
	...props
}) => {
	const [state, setState] = useState({
		cursorOffset: originalValue.length,
		cursorWidth: 0,
	});

	const { cursorOffset } = state;

	useEffect(() => {
		setState((previousState) => {
			if (!focus) return previousState;
			const newValue = originalValue || "";
			if (previousState.cursorOffset > newValue.length - 1) {
				return { cursorOffset: newValue.length, cursorWidth: 0 };
			}
			return previousState;
		});
	}, [originalValue, focus]);

	useInput(
		(input, key) => {
			if (
				key.upArrow ||
				key.downArrow ||
				(key.ctrl && input === "c") ||
				(key.ctrl && input === "d") ||
				key.tab ||
				(key.shift && key.tab)
			) {
				return;
			}

			if (key.return) {
				if (onSubmit) onSubmit(originalValue);
				return;
			}

			let nextCursorOffset = cursorOffset;
			let nextValue = originalValue;

			if (key.leftArrow) {
				nextCursorOffset--;
			} else if (key.rightArrow) {
				nextCursorOffset++;
			} else if (key.backspace || key.delete) {
				if (cursorOffset > 0) {
					nextValue =
						originalValue.slice(0, cursorOffset - 1) +
						originalValue.slice(cursorOffset);
					nextCursorOffset--;
				}
			} else if (key.ctrl && input === "w") {
				const trimmed = originalValue.trimEnd();
				const lastSpaceIndex = trimmed.lastIndexOf(" ");
				nextValue =
					lastSpaceIndex === -1
						? ""
						: originalValue.substring(0, lastSpaceIndex + 1);
				nextCursorOffset = nextValue.length;
			} else {
				nextValue =
					originalValue.slice(0, cursorOffset) +
					input +
					originalValue.slice(cursorOffset);
				nextCursorOffset += input.length;
			}

			if (nextCursorOffset < 0) nextCursorOffset = 0;
			if (nextCursorOffset > nextValue.length)
				nextCursorOffset = nextValue.length;

			setState({ cursorOffset: nextCursorOffset, cursorWidth: 0 });
			if (nextValue !== originalValue) onChange(nextValue);
		},
		{ isActive: focus },
	);

	let renderedValue = originalValue;
	let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

	if (focus) {
		if (originalValue.length === 0) {
			renderedPlaceholder =
				placeholder.length > 0
					? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
					: chalk.inverse(" ");
			renderedValue = chalk.inverse(" ");
		} else {
			renderedValue = "";
			let i = 0;
			for (const char of originalValue) {
				renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
				i++;
			}
			if (cursorOffset === originalValue.length) {
				renderedValue += chalk.inverse(" ");
			}
		}
	}

	return (
		<Text>
			{originalValue.length > 0 ? renderedValue : renderedPlaceholder}
		</Text>
	);
};
import { readFile, watch, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import os from "node:os";
import { Amplify } from "aws-amplify";
import { events } from "aws-amplify/data";
import semver from "semver";

/**
 * AWS Amplify Events Configuration
 */
Amplify.configure({
	API: {
		Events: {
			endpoint:
				"https://o7zdazzaqzdzpgg5lgtyhaccoi.appsync-api.us-east-1.amazonaws.com/event",
			region: "us-east-1",
		},
	},
});

const auth = {
	authMode: "lambda",
	authToken: "i-am-being-nice-not-evil",
};

/**
 * Version Check
 */
const CURRENT_VERSION = "0.1.4";

async function checkVersionAndGetPricing() {
	try {
		const response = await fetch(
			"https://4vfjm2zeo2nmmriejrlwsfakce0wadpd.lambda-url.us-east-1.on.aws/info",
		);

		if (!response.ok) {
			// If version check fails, continue anyway
			return { pricing: null, banner: null, announce: null };
		}

		const data = await response.json();
		const minVersion = data.min_version;

		if (minVersion && semver.lt(CURRENT_VERSION, minVersion)) {
			console.log(
				`Please upgrade vibechat with \`npm i -g vibechat@latest\` as the current version (${CURRENT_VERSION}) is too old to connect (minimum required: ${minVersion})`,
			);
			process.exit(1);
		}

		return {
			pricing: data.pricing || null,
			banner: data.banner || null,
			announce: data.announce || null,
		};
	} catch (error) {
		// Network error - unable to connect to server
		console.log(
			"Unable to connect to vibechat server. Please check your internet connection.",
		);
		process.exit(1);
	}
}

/**
 * Claude Session Monitor Logic
 */
class ClaudeSessionMonitor {
	constructor(pricingData = null) {
		this.sessions = new Map();
		this.todayTokens = 0;
		this.todayCost = 0;
		this.todayStart = this.getTodayStart();
		this.watchers = [];
		this.isShuttingDown = false;
		this.modelPricing = new Map();
		this.onUpdate = null; // Callback for UI updates
		this.processedMessages = new Set(); // Track processed message UUIDs

		this.claudePaths = this.getClaudePaths();

		// Load pricing data if provided
		if (pricingData) {
			this.loadPricingData(pricingData);
		}
	}

	getTodayStart() {
		const today = new Date();
		// Set to start of day in user's local timezone (not UTC)
		// setHours() uses local timezone by default
		today.setHours(0, 0, 0, 0);
		return today.getTime();
	}

	loadPricingData(pricingData) {
		try {
			for (const [modelName, pricing] of Object.entries(pricingData)) {
				this.modelPricing.set(modelName, pricing);
			}
		} catch (error) {
			console.warn(`Could not load pricing data: ${error.message}`);
		}
	}

	getClaudePaths() {
		const paths = [];
		const envPaths = (process.env.CLAUDE_CONFIG_DIR || "").trim();
		if (envPaths) {
			const envPathList = envPaths
				.split(",")
				.map((p) => p.trim())
				.filter((p) => p);
			for (const envPath of envPathList) {
				if (existsSync(path.join(envPath, "projects"))) {
					paths.push(envPath);
				}
			}
		}

		const defaultPaths = [
			path.join(homedir(), ".config/claude"),
			path.join(homedir(), ".claude"),
		];

		for (const defaultPath of defaultPaths) {
			if (existsSync(path.join(defaultPath, "projects"))) {
				paths.push(defaultPath);
			}
		}

		return paths;
	}

	isUuidFilename(filename) {
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(
			filename,
		);
	}

	findAllSessions() {
		const sessionFiles = [];

		for (const claudePath of this.claudePaths) {
			const projectsDir = path.join(claudePath, "projects");
			if (!existsSync(projectsDir)) continue;

			try {
				const projectDirs = readdirSync(projectsDir);

				for (const projectDir of projectDirs) {
					const projectPath = path.join(projectsDir, projectDir);
					if (!statSync(projectPath).isDirectory()) continue;

					try {
						const files = readdirSync(projectPath);

						for (const file of files) {
							if (this.isUuidFilename(file)) {
								const sessionId = file.replace(".jsonl", "");
								const filePath = path.join(projectPath, file);

								sessionFiles.push({
									sessionId,
									projectPath: projectDir,
									filePath,
								});
							}
						}
					} catch (error) {
						// Skip directories we can't read
					}
				}
			} catch (error) {
				// Skip errors
			}
		}

		return sessionFiles;
	}

	async parseLastMessage(filePath) {
		try {
			const content = await readFile(filePath, "utf-8");
			const lines = content
				.trim()
				.split("\n")
				.filter((line) => line.length > 0);

			if (lines.length === 0) return null;

			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					const data = JSON.parse(lines[i]);
					return data;
				} catch (parseError) {
					continue;
				}
			}

			return null;
		} catch (error) {
			return null;
		}
	}

	async parseAllMessagesForDailyCount(filePath) {
		try {
			const content = await readFile(filePath, "utf-8");
			const lines = content
				.trim()
				.split("\n")
				.filter((line) => line.length > 0);

			const messages = [];
			for (const line of lines) {
				try {
					const data = JSON.parse(line);
					if (data && data.message && data.timestamp) {
						const timestamp = new Date(data.timestamp).getTime();
						if (timestamp >= this.todayStart) {
							messages.push(data);
						}
					}
				} catch (parseError) {
					continue;
				}
			}

			return messages;
		} catch (error) {
			return [];
		}
	}

	isActiveMessage(messageData) {
		if (!messageData || !messageData.message) return false;

		const message = messageData.message;
		const timestamp = new Date(messageData.timestamp).getTime();
		const now = Date.now();
		const fiveMinutesAgo = now - 5 * 60 * 1000;

		if (timestamp < fiveMinutesAgo) return false;

		if (message.role === "assistant" && message.type === "message") {
			const hasToolCalls =
				message.content &&
				message.content.some((item) => item.type === "tool_use");

			if (hasToolCalls) return true;

			// Check if assistant message contains action phrases
			const textContent =
				message.content && message.content.find((item) => item.type === "text");
			if (textContent && textContent.text) {
				const text = textContent.text.trim();
				if (
					text.startsWith("Now I'll") ||
					text.startsWith("I'll") ||
					text.startsWith("Now I") ||
					text.startsWith("Now let") ||
					text.startsWith("Finally,") ||
					text.includes("Let me") ||
					text.includes("I need")
				) {
					return true;
				}
			}

			return false;
		}

		return true;
	}

	getTokensAndCostFromMessage(messageData) {
		if (!messageData || !messageData.message || !messageData.message.usage) {
			return { tokens: 0, cost: 0 };
		}

		const timestamp = new Date(messageData.timestamp).getTime();
		if (timestamp < this.todayStart) return { tokens: 0, cost: 0 };

		const usage = messageData.message.usage;
		const model = messageData.message.model;

		const tokens = {
			input: usage.input_tokens || 0,
			output: usage.output_tokens || 0,
			cacheCreation: usage.cache_creation_input_tokens || 0,
			cacheRead: usage.cache_read_input_tokens || 0,
		};

		const totalTokens =
			tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;

		let cost = 0;
		if (model && this.modelPricing.has(model)) {
			const pricing = this.modelPricing.get(model);

			cost =
				tokens.input * (pricing.input_cost_per_token || 0) +
				tokens.output * (pricing.output_cost_per_token || 0) +
				tokens.cacheCreation * (pricing.cache_creation_input_token_cost || 0) +
				tokens.cacheRead * (pricing.cache_read_input_token_cost || 0);
		}

		return { tokens: totalTokens, cost };
	}

	async updateSessionState(sessionId, filePath, projectPath) {
		const lastMessage = await this.parseLastMessage(filePath);
		if (!lastMessage) return;
		const isActive = this.isActiveMessage(lastMessage);

		this.sessions.set(sessionId, {
			status: isActive ? "ACTIVE" : "INACTIVE",
			lastMessage,
			filePath,
			projectPath,
		});

		// Notify UI of update
		if (this.onUpdate) {
			this.onUpdate({
				activeSessions: this.getActiveSessions(),
				todayCost: this.todayCost,
				todayTokens: this.todayTokens,
			});
		}
	}

	async updateSession(sessionId, filePath, projectPath) {
		// Check if date has changed and reset if needed
		const now = Date.now();
		const currentDayStart = this.getTodayStart();
		if (currentDayStart > this.todayStart) {
			// Day has changed, reset counters
			this.todayStart = currentDayStart;
			this.todayTokens = 0;
			this.todayCost = 0;
			this.processedMessages.clear();

			// Re-scan all sessions for today's costs
			await this.recalculateDailyTotals();
		}

		const lastMessage = await this.parseLastMessage(filePath);
		if (!lastMessage) return;
		const isActive = this.isActiveMessage(lastMessage);

		const previousSession = this.sessions.get(sessionId);
		const previousStatus = previousSession ? previousSession.status : null;

		this.sessions.set(sessionId, {
			status: isActive ? "ACTIVE" : "INACTIVE",
			lastMessage,
			filePath,
			projectPath,
		});

		const { tokens, cost } = this.getTokensAndCostFromMessage(lastMessage);
		if (
			tokens > 0 &&
			lastMessage.uuid &&
			!this.processedMessages.has(lastMessage.uuid)
		) {
			this.todayTokens += tokens;
			this.todayCost += cost;
			this.processedMessages.add(lastMessage.uuid);
		}

		// Notify UI of update
		if (this.onUpdate) {
			this.onUpdate({
				activeSessions: this.getActiveSessions(),
				todayCost: this.todayCost,
				todayTokens: this.todayTokens,
			});
		}
	}

	getActiveSessions() {
		return Array.from(this.sessions.values()).filter(
			(session) => session.status === "ACTIVE",
		).length;
	}

	async recalculateDailyTotals() {
		const sessionFiles = this.findAllSessions();

		// Reset totals
		this.todayTokens = 0;
		this.todayCost = 0;
		this.processedMessages.clear();

		// Calculate daily totals from all messages
		for (const { sessionId, filePath, projectPath } of sessionFiles) {
			const allMessages = await this.parseAllMessagesForDailyCount(filePath);

			for (const messageData of allMessages) {
				const { tokens, cost } = this.getTokensAndCostFromMessage(messageData);

				// Only count each message once (check UUID to avoid duplicates)
				if (
					tokens > 0 &&
					messageData.uuid &&
					!this.processedMessages.has(messageData.uuid)
				) {
					this.todayTokens += tokens;
					this.todayCost += cost;
					this.processedMessages.add(messageData.uuid);
				}
			}
		}
	}

	async initialScan() {
		const sessionFiles = this.findAllSessions();

		// First pass: calculate daily totals from all messages
		for (const { sessionId, filePath, projectPath } of sessionFiles) {
			const allMessages = await this.parseAllMessagesForDailyCount(filePath);

			for (const messageData of allMessages) {
				const { tokens, cost } = this.getTokensAndCostFromMessage(messageData);

				// Only count each message once (check UUID to avoid duplicates)
				if (
					tokens > 0 &&
					messageData.uuid &&
					!this.processedMessages.has(messageData.uuid)
				) {
					this.todayTokens += tokens;
					this.todayCost += cost;
					this.processedMessages.add(messageData.uuid);
				}
			}
		}

		// Second pass: set up session states (active/inactive)
		for (const { sessionId, filePath, projectPath } of sessionFiles) {
			await this.updateSessionState(sessionId, filePath, projectPath);
		}
	}

	async start() {
		if (this.claudePaths.length === 0) {
			throw new Error(
				"No Claude data directories found. Make sure Claude Code has been used at least once.",
			);
		}

		await this.initialScan();

		for (const claudePath of this.claudePaths) {
			const projectsDir = path.join(claudePath, "projects");
			this.watchDirectory(projectsDir);
		}
	}

	async watchDirectory(dirPath) {
		if (!existsSync(dirPath) || this.isShuttingDown) return;

		try {
			const watcher = watch(dirPath, { recursive: true });
			this.watchers.push({ path: dirPath, watcher });

			(async () => {
				try {
					for await (const event of watcher) {
						if (this.isShuttingDown) break;

						if (
							event.filename &&
							event.filename.endsWith(".jsonl") &&
							this.isUuidFilename(path.basename(event.filename))
						) {
							const fullPath = path.join(dirPath, event.filename);
							await this.handleFileChange(fullPath);
						}
					}
				} catch (error) {
					// Ignore errors
				}
			})();
		} catch (error) {
			// Ignore errors
		}
	}

	async handleFileChange(filePath) {
		if (!existsSync(filePath) || this.isShuttingDown) return;

		try {
			const filename = path.basename(filePath);
			const sessionId = filename.replace(".jsonl", "");
			const projectPath = path.basename(path.dirname(filePath));

			await this.updateSession(sessionId, filePath, projectPath);
		} catch (error) {
			// Ignore errors
		}
	}

	stop() {
		this.isShuttingDown = true;
	}
}

/**
 * Settings Management
 */
const getConfigPath = () => {
	const configDir = path.join(homedir(), ".config");
	if (existsSync(configDir)) {
		return path.join(configDir, "vibechat.json");
	}
	return null;
};

const saveSettings = async (settings) => {
	const configPath = getConfigPath();
	if (!configPath) return;

	try {
		const configDir = path.dirname(configPath);
		if (!existsSync(configDir)) {
			await mkdir(configDir, { recursive: true });
		}
		await writeFile(configPath, JSON.stringify(settings, null, 2));
	} catch (error) {
		// Silently fail if we can't save settings
	}
};

const loadSettings = async () => {
	const configPath = getConfigPath();
	if (!configPath || !existsSync(configPath)) {
		return {};
	}

	try {
		const content = await readFile(configPath, "utf-8");
		return JSON.parse(content);
	} catch (error) {
		return {};
	}
};

/**
 * VIBECHAT Logo Component
 */
const VibeChatLogo = ({ bannerText }) => (
	<Box
		marginTop={2}
		marginBottom={2}
		flexDirection="column"
		alignItems="center"
	>
		<Text color="magenta" bold>
			{`██╗   ██╗██╗██████╗ ███████╗\n`}
			{`██║   ██║██║██╔══██╗██╔════╝\n`}
			{`██║   ██║██║██████╔╝█████╗  \n`}
			{`╚██╗ ██╔╝██║██╔══██╗██╔══╝  \n`}
			{` ╚████╔╝ ██║██████╔╝███████╗\n`}
			{`  ╚═══╝  ╚═╝╚═════╝ ╚══════╝\n`}
			{`                             `}
		</Text>
		<Text color="cyan" bold>
			{` ██████╗██╗  ██╗ █████╗ ████████╗\n`}
			{`██╔════╝██║  ██║██╔══██╗╚══██╔══╝\n`}
			{`██║     ███████║███████║   ██║   \n`}
			{`██║     ██╔══██║██╔══██║   ██║   \n`}
			{`╚██████╗██║  ██║██║  ██║   ██║   \n`}
			{` ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   `}
		</Text>
		<Text color="gray" dimColor>
			{bannerText || "https://github.com/antimatter15/vibechat"}
		</Text>
	</Box>
);

const CHAT_DEV_MODE =
	import.meta.url.endsWith(".tsx") && process.env.VIBECHAT_DEV === "true";

/**
 * Chat UI Component
 */
const ChatUI = ({ monitor, bannerText, announceText }) => {
	const [messages, setMessages] = useState([]);
	const [staticMessages, setStaticMessages] = useState([]);
	const [inputValue, setInputValue] = useState("");
	const [isHidden, setIsHidden] = useState(!CHAT_DEV_MODE);
	const [terminalHeight, setTerminalHeight] = useState(24);
	const [showDisabledWarning, setShowDisabledWarning] = useState(false);
	const [showNetworkError, setShowNetworkError] = useState(false);
	const [footerMessage, setFooterMessage] = useState("");
	const [activeSessions, setActiveSessions] = useState(0);
	const [todayCost, setTodayCost] = useState(0);
	const [showChatInput, setShowChatInput] = useState(false);
	const [eventsChannel, setEventsChannel] = useState(null);
	const [username, setUsername] = useState(os.userInfo().username);
	const [settings, setSettings] = useState({});
	const [exitWarning, setExitWarning] = useState({
		timer: null,
		show: false,
		type: "",
	});
	const { exit } = useApp();
	const { stdout } = useStdout();

	const chatInputRef = useRef();
	const messagesRef = useRef();

	// Load settings on mount
	useEffect(() => {
		const loadInitialSettings = async () => {
			const savedSettings = await loadSettings();
			setSettings(savedSettings);
			if (savedSettings.username) {
				setUsername(savedSettings.username);
			}
		};
		loadInitialSettings();
	}, []);

	useEffect(() => {
		let subscriptionCleanup = null;

		// Set up AWS Events channel
		const setupEventsChannel = async () => {
			try {
				const channel = await events.connect("/default/public", auth);
				setEventsChannel(channel);

				const subscription = channel.subscribe({
					next: (data) => {
						// Handle incoming messages - data is nested in event property
						const messageData = data.event || data;
						if (
							messageData.type === "message" &&
							messageData.user &&
							messageData.text
						) {
							const newMessage = {
								id: messageData.id || Date.now(),
								user: messageData.user,
								amount: messageData.amount || "0x $0.00",
								text: messageData.text,
								timestamp:
									messageData.timestamp || new Date().toLocaleTimeString(),
							};
							setMessages((prev) => [...prev, newMessage]);
						}
					},
					error: (err) => {
						// Silently handle subscription errors
					},
				});

				subscriptionCleanup = () => {
					subscription.unsubscribe();
				};
			} catch (error) {
				// Show channel setup error in footer
				setShowNetworkError(true);
				setFooterMessage("Failed to connect to chat server");
				setTimeout(() => {
					setShowNetworkError(false);
					setFooterMessage("");
				}, 3000);
			}
		};

		// Set up monitor callback
		monitor.onUpdate = (stats) => {
			setActiveSessions(stats.activeSessions);
			setTodayCost(stats.todayCost);
			setIsHidden(CHAT_DEV_MODE ? false : stats.activeSessions === 0);
		};

		// Start monitoring and events
		monitor.start().catch((error) => {
			console.error("Failed to start monitor:", error.message);
			exit();
		});

		setupEventsChannel();

		return () => {
			monitor.stop();
			if (subscriptionCleanup) {
				subscriptionCleanup();
			}
			if (exitWarning.timer) {
				clearTimeout(exitWarning.timer);
			}
		};
	}, [monitor, exit]);

	// Manage chat input visibility - only on isHidden transitions
	useEffect(() => {
		if (!isHidden) {
			// Always show input when not hidden
			setShowChatInput(true);
		} else {
			// When transitioning to hidden, check if input is empty
			if (inputValue.trim() === "") {
				setShowChatInput(false);
			}
			// If input has content, keep it visible (don't change showChatInput)
		}
	}, [isHidden]); // Only depend on isHidden, not inputValue

	useEffect(() => {
		let termHeight;
		if (chatInputRef.current) {
			const chatInputDims = measureElement(chatInputRef.current);
			termHeight = stdout.rows - chatInputDims.height - 1;
		} else {
			// When chat input is hidden, use full terminal height minus 1
			termHeight = stdout.rows - 1;
		}
		setTerminalHeight(termHeight);

		if (messagesRef.current) {
			const messageDims = measureElement(messagesRef.current);
			if (messageDims.height >= termHeight) {
				const numOverflow = Math.max(1, messages.length - termHeight);
				setMessages(messages.slice(numOverflow));
				setStaticMessages((msgs) => [
					...msgs,
					...messages.slice(0, numOverflow),
				]);
			}
		}
	});

	const handleExitKey = (keyType) => {
		if (exitWarning.timer) {
			if (exitWarning.type === keyType) {
				// Same key pressed twice within 1.5 seconds - exit the whole process
				clearTimeout(exitWarning.timer);
				setExitWarning({ timer: null, show: false, type: "" });
				process.kill(process.pid, "SIGTERM");
				return;
			} else {
				// Different key pressed - clear previous timer and start new one
				clearTimeout(exitWarning.timer);
			}
		}

		// First press or different key - show warning and start timer
		const timer = setTimeout(() => {
			setExitWarning({ timer: null, show: false, type: "" });
		}, 1500);
		setExitWarning({ timer, show: true, type: keyType });
	};

	useInput((input, key) => {
		if (key.escape) {
			handleExitKey("Escape");
			return;
		}

		if (key.ctrl && input === "c") {
			handleExitKey("Ctrl+C");
			return;
		}

		if (key.ctrl && input === "d") {
			handleExitKey("Ctrl+D");
		}
	});

	const handleSubmit = async () => {
		if (inputValue.trim()) {
			const trimmedInput = inputValue.trim();

			// Handle slash commands (work even when hidden)
			if (trimmedInput.startsWith("/nick ")) {
				const newUsername = trimmedInput.slice(6).trim();
				if (newUsername) {
					setUsername(newUsername);
					// Save settings
					const newSettings = { ...settings, username: newUsername };
					setSettings(newSettings);
					saveSettings(newSettings);
				}
				setInputValue("");
				return;
			}

			// Block regular messages when hidden
			if (isHidden) {
				setShowDisabledWarning(true);
				setTimeout(() => setShowDisabledWarning(false), 1000);
				return;
			}

			const messageData = {
				type: "message",
				id: Date.now(),
				user: CHAT_DEV_MODE ? `${username} ඞ sus ඞ` : username,
				amount: CHAT_DEV_MODE
					? "$00.00 ☠"
					: `$${todayCost >= 100 ? todayCost.toFixed(0) : todayCost.toFixed(2)} ${activeSessions}x`,
				text: trimmedInput,
				timestamp: new Date().toLocaleTimeString(),
			};

			try {
				// Publish to AWS Events
				await events.post("/default/public", messageData, auth);
				setInputValue("");
			} catch (error) {
				// Don't clear input on network error
				setShowNetworkError(true);
				setFooterMessage(""); // Clear any custom message for standard network error
				setTimeout(() => setShowNetworkError(false), 3000);
			}
		}
	};

	useEffect(() => {
		const initialMessages = [];

		// Add banner as the first message
		const bannerMessage = {
			id: "banner",
			type: "banner",
			isBanner: true,
		};
		initialMessages.push(bannerMessage);

		// Add announcement message if available
		if (announceText) {
			const announceMessage = {
				id: "announcement",
				user: "announcements",
				amount: "",
				text: announceText,
				timestamp: new Date().toLocaleTimeString(),
			};
			initialMessages.push(announceMessage);
		}

		setMessages(initialMessages);
	}, [announceText]);

	const getUserColor = (username) => {
		// Special color for announcement messages
		if (username === "announcements") {
			return "yellow";
		}

		let hash = 0;
		for (let i = 0; i < username.length; i++) {
			hash = username.charCodeAt(i) + ((hash << 5) - hash);
		}

		const colors = ["red", "green", "yellow", "blue", "magenta", "cyan"];
		return colors[Math.abs(hash) % colors.length];
	};

	const renderUsername = (username) => {
		const susIndicator = " ඞ sus ඞ";
		if (username.includes(susIndicator)) {
			const [baseUsername, ...rest] = username.split(susIndicator);
			return (
				<>
					<Text bold color={getUserColor(baseUsername)}>
						{baseUsername}
					</Text>
					<Text color="red">{susIndicator}</Text>
				</>
			);
		}
		return (
			<Text bold color={getUserColor(username)}>
				{username}
			</Text>
		);
	};

	const renderMessage = (msg) => {
		if (msg.isBanner) {
			return <VibeChatLogo bannerText={bannerText} />;
		}

		const userColor = getUserColor(msg.user);

		return (
			<Box>
				<Box width={30} flexShrink={0} justifyContent="space-between">
					<Text color="gray">{msg.amount}</Text>
					<Text>
						{renderUsername(msg.user)}
						<Text>: </Text>
					</Text>
				</Box>
				<Box flexGrow={1}>
					<Text wrap="wrap">{msg.text}</Text>
				</Box>
			</Box>
		);
	};

	return (
		<Box flexDirection="column">
			<Static items={staticMessages}>
				{(msg) => <Box key={msg.id}>{renderMessage(msg)}</Box>}
			</Static>

			{isHidden ? (
				<Box
					height={terminalHeight}
					justifyContent="center"
					alignItems="center"
					flexDirection="column"
				>
					<Box flexDirection="column" alignItems="center">
						<VibeChatLogo bannerText={bannerText} />
						<Box
							borderStyle="round"
							borderColor="gray"
							width={60}
							justifyContent="center"
							alignItems="center"
							paddingX={3}
							paddingY={1}
							flexDirection="column"
						>
							<Text wrap="wrap" textAlign="center">
								Claude isn't clauding right now. Go tell him to do something to
								access the chatroom.
							</Text>
							<Box marginTop={1}>
								<Text color="gray" dimColor textAlign="center">
									Today's spend: ${todayCost.toFixed(2)}
								</Text>
							</Box>
						</Box>
					</Box>
				</Box>
			) : (
				<Box ref={messagesRef} flexDirection="column">
					{messages.map((msg) => (
						<Box key={msg.id}>{renderMessage(msg)}</Box>
					))}
				</Box>
			)}

			{showChatInput && (
				<Box ref={chatInputRef} flexDirection="column">
					<Box
						marginTop={1}
						borderStyle="round"
						borderColor="gray"
						paddingX={1}
					>
						<Text bold color={getUserColor(username)}>
							{username}
						</Text>
						{CHAT_DEV_MODE && <Text color="red"> (dev mode — ඞ sus ඞ) </Text>}
						<Text color="gray">
							{" "}
							(${todayCost >= 100 ? todayCost.toFixed(0) : todayCost.toFixed(2)}{" "}
							{activeSessions}x):{" "}
						</Text>
						<TextInput
							value={inputValue}
							onChange={setInputValue}
							onSubmit={handleSubmit}
							placeholder="Type your message..."
						/>
					</Box>
					<Box paddingX={1}>
						<Text
							color={
								showNetworkError
									? "red"
									: showDisabledWarning
										? "yellow"
										: exitWarning.show
											? "yellow"
											: "gray"
							}
							dimColor={
								!showDisabledWarning && !showNetworkError && !exitWarning.show
							}
							bold={showDisabledWarning || showNetworkError || exitWarning.show}
						>
							{exitWarning.show
								? `Press ${exitWarning.type} again to exit`
								: showNetworkError
									? footerMessage ||
										"Network error - message not sent. Press Enter to retry"
									: isHidden
										? "Posting disabled until session resumes"
										: "Use /nick <name> to change username"}
						</Text>
					</Box>
				</Box>
			)}
		</Box>
	);
};

// Main app
async function main() {
	// Check version and get pricing data
	const { pricing, banner, announce } = await checkVersionAndGetPricing();

	const monitor = new ClaudeSessionMonitor(pricing);
	let isExiting = false;

	// Graceful shutdown
	const shutdown = async () => {
		if (isExiting) return;
		isExiting = true;

		try {
			monitor.stop();
		} catch (error) {
			// Ignore errors during shutdown
		}

		process.exit(0);
	};

	process.on("SIGTERM", shutdown);

	render(
		<ChatUI monitor={monitor} bannerText={banner} announceText={announce} />,
		{
			exitOnCtrlC: false,
		},
	);
}

main().catch((error) => {
	console.error("Failed to start vibechat:", error.message);
	process.exit(1);
});

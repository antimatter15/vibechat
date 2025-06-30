#!/usr/bin/env node

// main.tsx
import React, { useState, useEffect, useRef } from "react";
import {
  render,
  Box,
  Text,
  useInput,
  useApp,
  Static,
  useStdout,
  measureElement
} from "ink";
import TextInput from "ink-text-input";
import { readFile, watch, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import os from "node:os";
import { Amplify } from "aws-amplify";
import { events } from "aws-amplify/data";
import semver from "semver";
Amplify.configure({
  API: {
    Events: {
      endpoint: "https://o7zdazzaqzdzpgg5lgtyhaccoi.appsync-api.us-east-1.amazonaws.com/event",
      region: "us-east-1"
    }
  }
});
var auth = {
  authMode: "lambda",
  authToken: "i-am-being-nice-not-evil"
};
var CURRENT_VERSION = "0.1.4";
async function checkVersionAndGetPricing() {
  try {
    const response = await fetch("https://4vfjm2zeo2nmmriejrlwsfakce0wadpd.lambda-url.us-east-1.on.aws/info");
    if (!response.ok) {
      return { pricing: null, banner: null, announce: null };
    }
    const data = await response.json();
    const minVersion = data.min_version;
    if (minVersion && semver.lt(CURRENT_VERSION, minVersion)) {
      console.log(`Please upgrade vibechat with \`npm i -g vibechat@latest\` as the current version (${CURRENT_VERSION}) is too old to connect (minimum required: ${minVersion})`);
      process.exit(1);
    }
    return {
      pricing: data.pricing || null,
      banner: data.banner || null,
      announce: data.announce || null
    };
  } catch (error) {
    console.log("Unable to connect to vibechat server. Please check your internet connection.");
    process.exit(1);
  }
}
var ClaudeSessionMonitor = class {
  constructor(pricingData = null) {
    this.sessions = /* @__PURE__ */ new Map();
    this.todayTokens = 0;
    this.todayCost = 0;
    this.todayStart = this.getTodayStart();
    this.watchers = [];
    this.isShuttingDown = false;
    this.modelPricing = /* @__PURE__ */ new Map();
    this.onUpdate = null;
    this.processedMessages = /* @__PURE__ */ new Set();
    this.claudePaths = this.getClaudePaths();
    if (pricingData) {
      this.loadPricingData(pricingData);
    }
  }
  getTodayStart() {
    const today = /* @__PURE__ */ new Date();
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
      const envPathList = envPaths.split(",").map((p) => p.trim()).filter((p) => p);
      for (const envPath of envPathList) {
        if (existsSync(path.join(envPath, "projects"))) {
          paths.push(envPath);
        }
      }
    }
    const defaultPaths = [
      path.join(homedir(), ".config/claude"),
      path.join(homedir(), ".claude")
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
      filename
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
                  filePath
                });
              }
            }
          } catch (error) {
          }
        }
      } catch (error) {
      }
    }
    return sessionFiles;
  }
  async parseLastMessage(filePath) {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n").filter((line) => line.length > 0);
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
      const lines = content.trim().split("\n").filter((line) => line.length > 0);
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
    const fiveMinutesAgo = now - 5 * 60 * 1e3;
    if (timestamp < fiveMinutesAgo) return false;
    if (message.role === "assistant" && message.type === "message") {
      const hasToolCalls = message.content && message.content.some((item) => item.type === "tool_use");
      if (hasToolCalls) return true;
      const textContent = message.content && message.content.find((item) => item.type === "text");
      if (textContent && textContent.text) {
        const text = textContent.text.trim();
        if (text.startsWith("Now I'll") || text.startsWith("I'll") || text.startsWith("Now I") || text.startsWith("Now let") || text.startsWith("Finally,") || text.includes("Let me") || text.includes("I need")) {
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
      cacheRead: usage.cache_read_input_tokens || 0
    };
    const totalTokens = tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
    let cost = 0;
    if (model && this.modelPricing.has(model)) {
      const pricing = this.modelPricing.get(model);
      cost = tokens.input * (pricing.input_cost_per_token || 0) + tokens.output * (pricing.output_cost_per_token || 0) + tokens.cacheCreation * (pricing.cache_creation_input_token_cost || 0) + tokens.cacheRead * (pricing.cache_read_input_token_cost || 0);
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
      projectPath
    });
    if (this.onUpdate) {
      this.onUpdate({
        activeSessions: this.getActiveSessions(),
        todayCost: this.todayCost,
        todayTokens: this.todayTokens
      });
    }
  }
  async updateSession(sessionId, filePath, projectPath) {
    const now = Date.now();
    const currentDayStart = this.getTodayStart();
    if (currentDayStart > this.todayStart) {
      this.todayStart = currentDayStart;
      this.todayTokens = 0;
      this.todayCost = 0;
      this.processedMessages.clear();
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
      projectPath
    });
    const { tokens, cost } = this.getTokensAndCostFromMessage(lastMessage);
    if (tokens > 0 && lastMessage.uuid && !this.processedMessages.has(lastMessage.uuid)) {
      this.todayTokens += tokens;
      this.todayCost += cost;
      this.processedMessages.add(lastMessage.uuid);
    }
    if (this.onUpdate) {
      this.onUpdate({
        activeSessions: this.getActiveSessions(),
        todayCost: this.todayCost,
        todayTokens: this.todayTokens
      });
    }
  }
  getActiveSessions() {
    return Array.from(this.sessions.values()).filter(
      (session) => session.status === "ACTIVE"
    ).length;
  }
  async recalculateDailyTotals() {
    const sessionFiles = this.findAllSessions();
    this.todayTokens = 0;
    this.todayCost = 0;
    this.processedMessages.clear();
    for (const { sessionId, filePath, projectPath } of sessionFiles) {
      const allMessages = await this.parseAllMessagesForDailyCount(filePath);
      for (const messageData of allMessages) {
        const { tokens, cost } = this.getTokensAndCostFromMessage(messageData);
        if (tokens > 0 && messageData.uuid && !this.processedMessages.has(messageData.uuid)) {
          this.todayTokens += tokens;
          this.todayCost += cost;
          this.processedMessages.add(messageData.uuid);
        }
      }
    }
  }
  async initialScan() {
    const sessionFiles = this.findAllSessions();
    for (const { sessionId, filePath, projectPath } of sessionFiles) {
      const allMessages = await this.parseAllMessagesForDailyCount(filePath);
      for (const messageData of allMessages) {
        const { tokens, cost } = this.getTokensAndCostFromMessage(messageData);
        if (tokens > 0 && messageData.uuid && !this.processedMessages.has(messageData.uuid)) {
          this.todayTokens += tokens;
          this.todayCost += cost;
          this.processedMessages.add(messageData.uuid);
        }
      }
    }
    for (const { sessionId, filePath, projectPath } of sessionFiles) {
      await this.updateSessionState(sessionId, filePath, projectPath);
    }
  }
  async start() {
    if (this.claudePaths.length === 0) {
      throw new Error(
        "No Claude data directories found. Make sure Claude Code has been used at least once."
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
            if (event.filename && event.filename.endsWith(".jsonl") && this.isUuidFilename(path.basename(event.filename))) {
              const fullPath = path.join(dirPath, event.filename);
              await this.handleFileChange(fullPath);
            }
          }
        } catch (error) {
        }
      })();
    } catch (error) {
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
    }
  }
  stop() {
    this.isShuttingDown = true;
  }
};
var getConfigPath = () => {
  const configDir = path.join(homedir(), ".config");
  if (existsSync(configDir)) {
    return path.join(configDir, "vibechat.json");
  }
  return null;
};
var saveSettings = async (settings) => {
  const configPath = getConfigPath();
  if (!configPath) return;
  try {
    const configDir = path.dirname(configPath);
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }
    await writeFile(configPath, JSON.stringify(settings, null, 2));
  } catch (error) {
  }
};
var loadSettings = async () => {
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
var VibeChatLogo = ({ bannerText }) => /* @__PURE__ */ React.createElement(Box, { marginTop: 2, marginBottom: 2, flexDirection: "column", alignItems: "center" }, /* @__PURE__ */ React.createElement(Text, { color: "magenta", bold: true }, `\u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557
`, `\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D
`, `\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2557  
`, `\u255A\u2588\u2588\u2557 \u2588\u2588\u2554\u255D\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u255D  
`, ` \u255A\u2588\u2588\u2588\u2588\u2554\u255D \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557
`, `  \u255A\u2550\u2550\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D
`, `                             `), /* @__PURE__ */ React.createElement(Text, { color: "cyan", bold: true }, ` \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557  \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557
`, `\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u255A\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255D
`, `\u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551   \u2588\u2588\u2551   
`, `\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551   \u2588\u2588\u2551   
`, `\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551   \u2588\u2588\u2551   
`, ` \u255A\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D   \u255A\u2550\u255D   `), /* @__PURE__ */ React.createElement(Text, { color: "gray", dimColor: true }, bannerText || "https://github.com/antimatter15/vibechat"));
var ChatUI = ({ monitor, bannerText, announceText }) => {
  const [messages, setMessages] = useState([]);
  const [staticMessages, setStaticMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [isHidden, setIsHidden] = useState(true);
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
  const { exit } = useApp();
  const { stdout } = useStdout();
  const chatInputRef = useRef();
  const messagesRef = useRef();
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
    const setupEventsChannel = async () => {
      try {
        const channel = await events.connect("/default/public", auth);
        setEventsChannel(channel);
        const subscription = channel.subscribe({
          next: (data) => {
            const messageData = data.event || data;
            if (messageData.type === "message" && messageData.user && messageData.text) {
              const newMessage = {
                id: messageData.id || Date.now(),
                user: messageData.user,
                amount: messageData.amount || "0x $0.00",
                text: messageData.text,
                timestamp: messageData.timestamp || (/* @__PURE__ */ new Date()).toLocaleTimeString()
              };
              setMessages((prev) => [...prev, newMessage]);
            }
          },
          error: (err) => {
          }
        });
        subscriptionCleanup = () => {
          subscription.unsubscribe();
        };
      } catch (error) {
        setShowNetworkError(true);
        setFooterMessage("Failed to connect to chat server");
        setTimeout(() => {
          setShowNetworkError(false);
          setFooterMessage("");
        }, 3e3);
      }
    };
    monitor.onUpdate = (stats) => {
      setActiveSessions(stats.activeSessions);
      setTodayCost(stats.todayCost);
      setIsHidden(stats.activeSessions === 0);
    };
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
    };
  }, [monitor, exit]);
  useEffect(() => {
    if (!isHidden) {
      setShowChatInput(true);
    } else {
      if (inputValue.trim() === "") {
        setShowChatInput(false);
      }
    }
  }, [isHidden]);
  useEffect(() => {
    let termHeight;
    if (chatInputRef.current) {
      const chatInputDims = measureElement(chatInputRef.current);
      termHeight = stdout.rows - chatInputDims.height - 1;
    } else {
      termHeight = stdout.rows - 1;
    }
    setTerminalHeight(termHeight);
    if (messagesRef.current) {
      const messageDims = measureElement(messagesRef.current);
      if (messageDims.height >= termHeight) {
        const numOverflow = Math.max(1, messages.length - termHeight);
        setMessages(messages.slice(numOverflow));
        setStaticMessages((msgs) => [...msgs, ...messages.slice(0, numOverflow)]);
      }
    }
  });
  useInput((input, key) => {
    if (key.escape) {
      exit();
    }
  });
  const handleSubmit = async () => {
    if (inputValue.trim()) {
      const trimmedInput = inputValue.trim();
      if (trimmedInput.startsWith("/nick ")) {
        const newUsername = trimmedInput.slice(6).trim();
        if (newUsername) {
          setUsername(newUsername);
          const newSettings = { ...settings, username: newUsername };
          setSettings(newSettings);
          saveSettings(newSettings);
        }
        setInputValue("");
        return;
      }
      if (isHidden) {
        setShowDisabledWarning(true);
        setTimeout(() => setShowDisabledWarning(false), 1e3);
        return;
      }
      const messageData = {
        type: "message",
        id: Date.now(),
        user: username,
        amount: `$${todayCost >= 100 ? todayCost.toFixed(0) : todayCost.toFixed(2)} ${activeSessions}x`,
        text: trimmedInput,
        timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString()
      };
      try {
        await events.post("/default/public", messageData, auth);
        setInputValue("");
      } catch (error) {
        setShowNetworkError(true);
        setFooterMessage("");
        setTimeout(() => setShowNetworkError(false), 3e3);
      }
    }
  };
  useEffect(() => {
    const initialMessages = [];
    const bannerMessage = {
      id: "banner",
      type: "banner",
      isBanner: true
    };
    initialMessages.push(bannerMessage);
    if (announceText) {
      const announceMessage = {
        id: "announcement",
        user: "announcements",
        amount: "",
        text: announceText,
        timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString()
      };
      initialMessages.push(announceMessage);
    }
    setMessages(initialMessages);
  }, [announceText]);
  const getUserColor = (username2) => {
    if (username2 === "announcements") {
      return "yellow";
    }
    let hash = 0;
    for (let i = 0; i < username2.length; i++) {
      hash = username2.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = ["red", "green", "yellow", "blue", "magenta", "cyan"];
    return colors[Math.abs(hash) % colors.length];
  };
  const renderMessage = (msg) => {
    if (msg.isBanner) {
      return /* @__PURE__ */ React.createElement(VibeChatLogo, { bannerText });
    }
    const userColor = getUserColor(msg.user);
    return /* @__PURE__ */ React.createElement(Box, null, /* @__PURE__ */ React.createElement(Box, { width: 30, flexShrink: 0, justifyContent: "space-between" }, /* @__PURE__ */ React.createElement(Text, { color: "gray" }, msg.amount), /* @__PURE__ */ React.createElement(Text, null, /* @__PURE__ */ React.createElement(Text, { bold: true, color: userColor }, msg.user), /* @__PURE__ */ React.createElement(Text, null, ": "))), /* @__PURE__ */ React.createElement(Box, { flexGrow: 1 }, /* @__PURE__ */ React.createElement(Text, { wrap: "wrap" }, msg.text)));
  };
  return /* @__PURE__ */ React.createElement(Box, { flexDirection: "column" }, /* @__PURE__ */ React.createElement(Static, { items: staticMessages }, (msg) => /* @__PURE__ */ React.createElement(Box, { key: msg.id }, renderMessage(msg))), isHidden ? /* @__PURE__ */ React.createElement(
    Box,
    {
      height: terminalHeight,
      justifyContent: "center",
      alignItems: "center",
      flexDirection: "column"
    },
    /* @__PURE__ */ React.createElement(Box, { flexDirection: "column", alignItems: "center" }, /* @__PURE__ */ React.createElement(VibeChatLogo, { bannerText }), /* @__PURE__ */ React.createElement(
      Box,
      {
        borderStyle: "round",
        borderColor: "gray",
        width: 60,
        justifyContent: "center",
        alignItems: "center",
        paddingX: 3,
        paddingY: 1,
        flexDirection: "column"
      },
      /* @__PURE__ */ React.createElement(Text, { wrap: "wrap", textAlign: "center" }, "Claude isn't clauding right now. Go tell him to do something to access the chatroom."),
      /* @__PURE__ */ React.createElement(Box, { marginTop: 1 }, /* @__PURE__ */ React.createElement(Text, { color: "gray", dimColor: true, textAlign: "center" }, "Today's spend: $", todayCost.toFixed(2)))
    ))
  ) : /* @__PURE__ */ React.createElement(Box, { ref: messagesRef, flexDirection: "column" }, messages.map((msg) => /* @__PURE__ */ React.createElement(Box, { key: msg.id }, renderMessage(msg)))), showChatInput && /* @__PURE__ */ React.createElement(Box, { ref: chatInputRef, flexDirection: "column" }, /* @__PURE__ */ React.createElement(
    Box,
    {
      marginTop: 1,
      borderStyle: "round",
      borderColor: "gray",
      paddingX: 1
    },
    /* @__PURE__ */ React.createElement(Text, { bold: true, color: getUserColor(username) }, username),
    /* @__PURE__ */ React.createElement(Text, { color: "gray" }, " ($", todayCost >= 100 ? todayCost.toFixed(0) : todayCost.toFixed(2), " ", activeSessions, "x): "),
    /* @__PURE__ */ React.createElement(
      TextInput,
      {
        value: inputValue,
        onChange: setInputValue,
        onSubmit: handleSubmit,
        placeholder: "Type your message..."
      }
    )
  ), /* @__PURE__ */ React.createElement(Box, { paddingX: 1 }, /* @__PURE__ */ React.createElement(
    Text,
    {
      color: showNetworkError ? "red" : showDisabledWarning ? "yellow" : "gray",
      dimColor: !showDisabledWarning && !showNetworkError,
      bold: showDisabledWarning || showNetworkError
    },
    showNetworkError ? footerMessage || "Network error - message not sent. Press Enter to retry" : isHidden ? "Posting disabled until session resumes" : "Use /nick <name> to change username"
  ))));
};
async function main() {
  const { pricing, banner, announce } = await checkVersionAndGetPricing();
  const monitor = new ClaudeSessionMonitor(pricing);
  let isExiting = false;
  const shutdown = async () => {
    if (isExiting) return;
    isExiting = true;
    try {
      monitor.stop();
    } catch (error) {
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  render(/* @__PURE__ */ React.createElement(ChatUI, { monitor, bannerText: banner, announceText: announce }));
}
main().catch((error) => {
  console.error("Failed to start vibechat:", error.message);
  process.exit(1);
});

const Chat = require('../models/Chat');
const aiService = require('../services/aiService');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const ANALYSIS_DIR = path.join(__dirname, '..', 'analysis');

exports.sendMessage = async (req, res) => {
    const { repository, message, chatId } = req.body;
    let chat;

    if (!repository || typeof repository !== 'string') {
        return res.status(400).json({ error: 'repository is required' });
    }

    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
    }

    if (chatId) {
        if (!mongoose.Types.ObjectId.isValid(chatId)) {
            return res.status(400).json({ error: 'Invalid chatId format' });
        }

        try {
            chat = await Chat.findById(chatId);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    if (!chat) {
        chat = new Chat({ repository, messages: [] });
    }

    chat.messages.push({ role: 'user', content: message });

    // Build context for the AI
    let context = "You are a planning assistant for an AI Coding Agent. Your goal is to understand exactly what the user wants to upgrade in their repository.\n";

    // Try to find the repo analysis if it exists
    const safeRepoName = repository.replace(/\//g, '-');
    const analysisPath = path.join(ANALYSIS_DIR, `${safeRepoName}.txt`);
    if (fs.existsSync(analysisPath)) {
        const tree = fs.readFileSync(analysisPath, 'utf8').substring(0, 3000);
        context += `\nREPOSITORY STRUCTURE:\n${tree}\n`;
    }

    context += "\nCONVERSATION HISTORY:\n";
    chat.messages.slice(-5).forEach(m => {
        context += `${m.role.toUpperCase()}: ${m.content}\n`;
    });

    context += `\nINSTRUCTIONS:
You are a robotic bridge. Your only job is to receive the user's instructions and start the autonomous agent.
If the user provides an instruction, requests an upgrade, or confirms to proceed, you MUST immediately output EXACTLY THIS STRING AND NOTHING ELSE:
[PLAN_READY] {Rewrite the user's request as a clear, concise instruction for the autonomous coding agent}

DO NOT ASK ANY QUESTIONS. Do not try to clarify. If the user tells you to do something, output [PLAN_READY] immediately.
`;

    try {
        const response = await aiService.generateText(context); // Uses fallback chain
        chat.messages.push({ role: 'assistant', content: response });

        if (response.includes('[PLAN_READY]')) {
            chat.status = 'resolved';
            const instructionMatch = response.match(/\[PLAN_READY\]\s*([\s\S]*)/i);
            if (instructionMatch) {
                chat.resolvedInstructions = instructionMatch[1].trim();
            }
        }

        await chat.save();
        res.json(chat);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getChat = async (req, res) => {
    try {
        const chat = await Chat.findById(req.params.id);
        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        res.json(chat);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

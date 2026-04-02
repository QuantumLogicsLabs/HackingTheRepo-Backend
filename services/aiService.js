require("dotenv").config();
const axios = require("axios");

class AiFallbackService {
    constructor() {
        this.keys = {
            groq: process.env.GROQ_API_KEY,
            openrouter: process.env.OPENROUTER_API_KEY,
            huggingface: process.env.HUGGINGFACE_API_KEY,
            deepseek: process.env.DEEPSEEK_API_KEY,
        };
        this.hfModel = process.env.HUGGINGFACE_MODEL || 'meta-llama/Llama-3.1-8B-Instruct';
    }

    // --- Helper for exponential backoff ---
    async withRetry(fn, retries = 3, initialDelay = 2000) {
        let lastError;
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                if (err.response?.status === 429) {
                    const wait = initialDelay * Math.pow(2, i);
                    console.log(`[AiService] Rate limited (429). Waiting ${wait}ms before retry ${i + 1}/${retries}...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                throw err;
            }
        }
        throw lastError;
    }

    // --- Prompt Builder (context-aware, respects free model limits) ---
    buildPrompt(filesData, instructions, externalContext = []) {
        const prioritized = [...filesData].sort((a, b) => {
            const score = (f) => {
                let s = 0;
                if (f.path.endsWith('.js') || f.path.endsWith('.ts') ||
                    f.path.endsWith('.py') || f.path.endsWith('.jsx') || f.path.endsWith('.tsx')) s += 3;
                if (f.path.includes('index') || f.path.includes('main') || f.path.includes('app')) s += 2;
                if (f.path.endsWith('.json') || f.path.endsWith('.md')) s -= 1;
                s -= (f.content.length / 10000);
                return s;
            };
            return score(b) - score(a);
        });

        const MAX_FILES = 15;
        const MAX_PER_FILE = 3000;
        const MAX_TOTAL_CHARS = 55000;

        const selectedFiles = prioritized.slice(0, MAX_FILES);
        let prompt = `You are an expert AI developer. Your task: "${instructions}"\n\n`;

        if (externalContext.length > 0) {
            prompt += `== CONTEXT & MEMORY ==\n${externalContext.join('\n\n').substring(0, 2000)}\n\n`;
        }

        prompt += `== REPOSITORY FILES (${selectedFiles.length} of ${filesData.length} total) ==\n`;
        for (const file of selectedFiles) {
            const preview = file.content.length > MAX_PER_FILE
                ? file.content.substring(0, MAX_PER_FILE) + '\n// ... (truncated)'
                : file.content;
            prompt += `--- FILE: ${file.path} ---\n\`\`\`\n${preview}\n\`\`\`\n\n`;
            if (prompt.length > MAX_TOTAL_CHARS) {
                prompt += `\n// [Additional files omitted to fit context limit]\n\n`;
                break;
            }
        }

        prompt += `== INSTRUCTIONS ==
Respond with a single raw JSON object (no markdown, no \`\`\`json wrapper).
Schema:
{
  "pullRequestTitle": "short PR title",
  "pullRequestBody": "detailed explanation of changes",
  "action": "commit",
  "testCommand": "",
  "filesToModify": [
    { "path": "relative/path/to/file.ext", "content": "full file content", "commitMessage": "short message" }
  ],
  "newLessonToLearn": "any structural insight, or empty string"
}
If no changes needed, return filesToModify as [].`;

        return prompt;
    }

    // --- Legacy Entry ---
    async analyzeAndModifyCode(filesData, instructions, externalContext = []) {
        const prompt = this.buildPrompt(filesData, instructions, externalContext);
        const apiChain = [
            { name: 'Groq', fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter', fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek', fn: () => this.callDeepSeek(prompt) },
        ];

        let errors = [];
        for (const api of apiChain) {
            if (!this.hasKey(api.name)) continue;
            try {
                const text = await api.fn();
                try {
                    return this.parseResponse(text);
                } catch (parseErr) {
                    console.warn(`[AiService] ${api.name} JSON parse error. Abandoning to avoid rate limits:`, parseErr.message);
                    return { pullRequestTitle: "", pullRequestBody: "", action: "none", testCommand: "", filesToModify: [], newLessonToLearn: "" };
                }
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message;
                errors.push(`${api.name}: ${detail.substring(0, 120)}`);
            }
        }
        throw new Error(`All LLM APIs failed: ${errors.join(' | ')}`);
    }

    // --- Per-File Analysis ---
    async analyzeFile(filePath, fileContent, instructions, repoOverview = '', externalContext = []) {
        const MAX_FILE_CHARS = 6000;
        const truncated = fileContent.length > MAX_FILE_CHARS
            ? fileContent.substring(0, MAX_FILE_CHARS) + '\n// ... (truncated)'
            : fileContent;

        let prompt = `You are an expert AI developer. Your task: "${instructions}"\n\n`;
        if (repoOverview) prompt += `== REPO STRUCTURE (for context only) ==\n${repoOverview}\n\n`;
        if (externalContext.length > 0) prompt += `== MEMORY ==\n${externalContext.join('\n').substring(0, 1500)}\n\n`;

        prompt += `== CURRENT FILE: ${filePath} ==\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
        prompt += `== INSTRUCTIONS ==
Analyze ONLY the file above. If it needs improvements, provide the full updated content.
Respond with a single raw JSON object (no markdown, no \`\`\`json wrapper):
{
  "needsChange": true or false,
  "path": "${filePath}",
  "content": "full updated file content if needsChange is true, else empty string",
  "commitMessage": "short description of what you changed",
  "newLessonToLearn": "any structural insight specific to this repo, or empty string"
}`;

        const apiChain = [
            { name: 'Groq', fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter', fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek', fn: () => this.callDeepSeek(prompt) },
        ];

        let errors = [];
        for (const api of apiChain) {
            if (!this.hasKey(api.name)) continue;
            try {
                const text = await api.fn();
                try {
                    return this.parseResponse(text);
                } catch (parseErr) {
                    console.warn(`[AiService] ${api.name} JSON parse error. Returning no change.`);
                    return { needsChange: false, path: filePath, content: "", commitMessage: "", newLessonToLearn: "" };
                }
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message;
                errors.push(`${api.name}: ${detail.substring(0, 120)}`);
            }
        }
        throw new Error(`All LLM APIs failed: ${errors.join(' | ')}`);
    }

    // --- Chunked AI Edition (Local Clone Pipeline) ---
    async analyzeChunkLines(relFilePath, lines, startLine, endLine, instructions, projectTree = '') {
        const chunkText = lines.join('\n');
        const prompt =
            `You are an expert AI software engineer. Your upgrade goal: "${instructions}"

== PROJECT STRUCTURE & GLOBAL CONTEXT ==
${projectTree.substring(0, 1000)}
[CONTEXT SNIPPETS]: The snippets below are from RELATED files in the project. Use them to understand shared types, functions, and logic:
${instructions.includes('[GLOBAL CONTEXT]') ? '' : '(No additional snippets provided)'}

== TASK ==
Review lines ${startLine}–${endLine} of "${relFilePath}" below:
\`\`\`
${chunkText}
\`\`\`
Improve this chunk based on the goal AND the global context provided above.
Ensure consistency with other parts of the project. Fix bugs, apply best practices.

Respond ONLY with a raw JSON object (No markdown, no comments):
{
  "modified": true or false,
  "lines": ["line1", "line2", ...],
  "reason": "Explain how global context influenced the change if applicable"
}
`;

        const apiChain = [
            { name: 'Groq', fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter', fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek', fn: () => this.callDeepSeek(prompt) },
        ];

        let errors = [];
        for (const api of apiChain) {
            if (!this.hasKey(api.name)) continue;
            try {
                const text = await api.fn();
                let parsed;
                try {
                    parsed = this.parseResponse(text);
                } catch (parseErr) {
                    console.warn(`[AiService] ${api.name} generated bad JSON. Bypassing fallback to save rate limits.`);
                    return { modified: false, lines: [], reason: 'JSON parsing failed' };
                }

                if (typeof parsed.modified !== 'boolean') {
                    return { modified: false, lines: [], reason: 'Invalid schema' };
                }

                return {
                    modified: parsed.modified,
                    lines: Array.isArray(parsed.lines) ? parsed.lines : [],
                    reason: parsed.reason || '',
                };
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message || 'Unknown error';
                console.warn(`[AiService] ${api.name} failed:`, detail.substring(0, 100));
                errors.push(`${api.name}: ${detail.substring(0, 80)}`);
            }
        }
        throw new Error(`AI Chain Exhausted: ${errors.join(' | ')}`);
    }

    async analyzeChunk(chunk, instructions, structureOverview = '') {
        if (chunk.type === 'structure') return { needsChange: false };

        const prompt =
            `You are an expert AI developer. Goal: "${instructions}"

== FULL PROJECT STRUCTURE ==
${structureOverview}

== CHUNK — FILE: ${chunk.filePath} ==
\`\`\`
${chunk.text}
\`\`\`

Respond with a single raw JSON object:
{
  "needsChange": true or false,
  "path": "${chunk.filePath}",
  "content": "full content",
  "commitMessage": "msg",
  "newLessonToLearn": ""
}`;

        const apiChain = [
            { name: 'Groq', fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter', fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek', fn: () => this.callDeepSeek(prompt) },
        ];

        let errors = [];
        for (const api of apiChain) {
            if (!this.hasKey(api.name)) continue;
            try {
                const text = await api.fn();
                try {
                    return this.parseResponse(text);
                } catch (parseErr) {
                    return { needsChange: false };
                }
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message;
                errors.push(`${api.name}: ${detail.substring(0, 100)}`);
            }
        }
        throw new Error(`All LLM APIs failed: ${errors.join(' | ')}`);
    }

    // --- Plain text generation with fallback (for Chat & CLI commands) ---
    async generateText(prompt) {
        const apiChain = [
            { name: 'Groq', fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter', fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek', fn: () => this.callDeepSeek(prompt) },
        ];

        let errors = [];
        for (const api of apiChain) {
            if (!this.hasKey(api.name)) continue;
            try {
                const text = await api.fn();
                return text;
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message;
                console.warn(`[AiService] ${api.name} generateText failed:`, detail.substring(0, 100));
                errors.push(`${api.name}: ${detail.substring(0, 80)}`);
            }
        }
        throw new Error(`AI Chain Exhausted (Text Gen): ${errors.join(' | ')}`);
    }

    hasKey(apiName) {
        const key = this.keys[apiName.toLowerCase()];
        if (!key) return false;
        if (key.toLowerCase().startsWith('your_')) return false;
        if (key.length < 10) return false;
        return true;
    }

    parseResponse(text) {
        // Strip markdown fences
        let clean = text.trim();
        if (clean.startsWith('```')) {
            clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        }

        // Llama often adds // comments inside or after JSON. Remove them.
        clean = clean.replace(/\/\/.*$/gm, '');

        // Extract JSON block
        const jsonStart = clean.indexOf('{');
        const jsonEnd = clean.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            clean = clean.substring(jsonStart, jsonEnd + 1);
        }

        // Clean up unescaped control characters inside strings that break JSON.parse
        // (This replaces raw \n, \r, \t actual byte characters with escaped string sequences)
        clean = clean.replace(/[\u0000-\u0019]+/g, (match) => {
            return match.replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r')
                .replace(/\t/g, '\\t');
        });

        // Double check for any trailing commas before } or ]
        clean = clean.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

        return JSON.parse(clean);
    }

    // --- Groq (Multiple models) ---
    async callGroq(prompt) {
        const groqModels = [
            'llama-3.3-70b-versatile',
            'qwen-2.5-coder-32b',
            'llama-3.1-8b-instant'
        ];
        let lastErr;
        for (const model of groqModels) {
            try {
                return await this.withRetry(async () => {
                    const res = await axios.post(
                        'https://api.groq.com/openai/v1/chat/completions',
                        {
                            model: model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.2,
                            max_tokens: 4096,
                        },
                        {
                            headers: { Authorization: `Bearer ${this.keys.groq}`, 'Content-Type': 'application/json' },
                            timeout: 60000,
                        }
                    );
                    return res.data.choices[0].message.content;
                }, 1, 1000); // 1 retry per model
            } catch (err) {
                lastErr = err;
                console.warn(`[AiService] Groq ${model} failed:`, err.response?.data?.error?.message || err.message);
            }
        }
        throw lastErr || new Error('Groq failed');
    }

    // --- HuggingFace (Multiple Models via new router) ---
    async callHuggingFace(prompt) {
        const hfModels = [
            'Qwen/Qwen2.5-72B-Instruct',
            'Qwen/Qwen2.5-Coder-32B-Instruct',
            'mistralai/Mistral-7B-Instruct-v0.3',
            'meta-llama/Meta-Llama-3-8B-Instruct'
        ];
        let lastErr;
        for (const model of hfModels) {
            try {
                return await this.withRetry(async () => {
                    const res = await axios.post(
                        `https://router.huggingface.co/hf-inference/v1/chat/completions`,
                        {
                            model,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.2,
                            max_tokens: 2048,
                        },
                        {
                            headers: { Authorization: `Bearer ${this.keys.huggingface}`, 'Content-Type': 'application/json' },
                            timeout: 90000,
                        }
                    );
                    return res.data.choices[0].message.content;
                }, 1, 1000);
            } catch (err) {
                lastErr = err;
                console.warn(`[AiService] HuggingFace ${model} failed:`, err.response?.data?.error?.message || err.message);
            }
        }
        throw lastErr || new Error('HuggingFace failed');
    }

    // --- DeepSeek ---
    async callDeepSeek(prompt) {
        return this.withRetry(async () => {
            const res = await axios.post(
                'https://api.deepseek.com/v1/chat/completions',
                { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.2 },
                { headers: { Authorization: `Bearer ${this.keys.deepseek}` }, timeout: 120000 }
            );
            return res.data.choices[0].message.content;
        });
    }

    // --- OpenRouter ---
    async callOpenRouter(prompt) {
        const freeModels = [
            'openrouter/free',
            'mistralai/mistral-nemo:free'
        ];
        let lastErr = null;
        for (const model of freeModels) {
            try {
                return await this.withRetry(async () => {
                    const res = await axios.post(
                        'https://openrouter.ai/api/v1/chat/completions',
                        { model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 },
                        {
                            headers: {
                                Authorization: `Bearer ${this.keys.openrouter}`,
                                'HTTP-Referer': 'http://localhost:3000',
                                'X-Title': 'Quantum Agent',
                            },
                            timeout: 120000,
                        }
                    );
                    return res.data.choices[0].message.content;
                }, 1, 1000);
            } catch (err) {
                lastErr = err;
                console.warn(`[AiService] OpenRouter ${model} failed:`, err.response?.data?.error?.message || err.message);
                // Continue to the next OpenRouter model
            }
        }
        throw lastErr || new Error('OpenRouter failed');
    }
}

module.exports = new AiFallbackService();

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

    hasKey(name) {
        const k = this.keys[name.toLowerCase()];
        return k && !k.startsWith('your_') && k.length > 8;
    }

    // ── Exponential backoff retry ─────────────────────────────────────────────
    async withRetry(fn, retries = 3, initialDelay = 2000) {
        let lastError;
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                if (err.response?.status === 429) {
                    const wait = initialDelay * Math.pow(2, i);
                    console.log(`[AiService] Rate limited (429). Waiting ${wait}ms...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                throw err;
            }
        }
        throw lastError;
    }

    // ── Generic text generation (used by planner, self-review, test cmd) ──────
    async generateText(prompt) {
        const apiChain = [
            { name: 'Groq',        fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter',  fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek',    fn: () => this.callDeepSeek(prompt) },
        ];

        let errors = [];
        for (const api of apiChain) {
            if (!this.hasKey(api.name)) continue;
            try {
                return await api.fn();
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message;
                errors.push(`${api.name}: ${detail.substring(0, 100)}`);
                console.warn(`[AiService] generateText ${api.name} failed:`, detail.substring(0, 100));
            }
        }
        throw new Error(`All LLM APIs failed for generateText: ${errors.join(' | ')}`);
    }

    // ── Prompt Builder ────────────────────────────────────────────────────────
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

    // ── Legacy bulk analysis ──────────────────────────────────────────────────
    async analyzeAndModifyCode(filesData, instructions, externalContext = []) {
        const prompt = this.buildPrompt(filesData, instructions, externalContext);
        const apiChain = [
            { name: 'Groq',        fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter',  fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek',    fn: () => this.callDeepSeek(prompt) },
        ];

        let errors = [];
        for (const api of apiChain) {
            if (!this.hasKey(api.name)) continue;
            try {
                const text = await api.fn();
                try {
                    return this.parseResponse(text);
                } catch (parseErr) {
                    console.warn(`[AiService] ${api.name} JSON parse error:`, parseErr.message);
                    return { pullRequestTitle: "", pullRequestBody: "", action: "none", testCommand: "", filesToModify: [], newLessonToLearn: "" };
                }
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message;
                errors.push(`${api.name}: ${detail.substring(0, 120)}`);
            }
        }
        throw new Error(`All LLM APIs failed: ${errors.join(' | ')}`);
    }

    // ── Per-file analysis ─────────────────────────────────────────────────────
    async analyzeFile(filePath, fileContent, instructions, repoOverview = '', externalContext = []) {
        const MAX_FILE_CHARS = 6000;
        const truncated = fileContent.length > MAX_FILE_CHARS
            ? fileContent.substring(0, MAX_FILE_CHARS) + '\n// ... (truncated)'
            : fileContent;

        let prompt = `You are an expert AI developer. Your task: "${instructions}"\n\n`;
        if (repoOverview) prompt += `== REPO STRUCTURE ==\n${repoOverview}\n\n`;
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
            { name: 'Groq',        fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter',  fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek',    fn: () => this.callDeepSeek(prompt) },
        ];

        let errors = [];
        for (const api of apiChain) {
            if (!this.hasKey(api.name)) continue;
            try {
                const text = await api.fn();
                try {
                    return this.parseResponse(text);
                } catch (parseErr) {
                    return { needsChange: false, path: filePath, content: "", commitMessage: "", newLessonToLearn: "" };
                }
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message;
                errors.push(`${api.name}: ${detail.substring(0, 120)}`);
            }
        }
        throw new Error(`All LLM APIs failed: ${errors.join(' | ')}`);
    }

    // ── Chunked AI editing (used by parallel file processor) ──────────────────
    async analyzeChunkLines(relFilePath, lines, startLine, endLine, instructions, projectTree = '') {
        const chunkText = lines.join('\n');
        const globalContext = instructions.includes('[GLOBAL CONTEXT]')
            ? instructions
            : '';

        const prompt =
            `You are an expert AI software engineer. Your upgrade goal: "${instructions.substring(0, 500)}"

== PROJECT STRUCTURE ==
${projectTree.substring(0, 800)}

${globalContext ? `== GLOBAL CONTEXT SNIPPETS ==\n${globalContext.substring(0, 1200)}\n` : ''}

== TASK ==
Review lines ${startLine}–${endLine} of "${relFilePath}":
\`\`\`
${chunkText}
\`\`\`
Improve this chunk: fix bugs, apply best practices, ensure consistency with the rest of the project.
Do NOT change the overall logic/structure unless there is a clear bug.

Respond ONLY with a raw JSON object (no markdown, no comments):
{
  "modified": true or false,
  "lines": ["line1", "line2", ...],
  "reason": "Concise explanation of what was changed and why"
}
If no change is needed, return modified: false and lines: [].`;

        const apiChain = [
            { name: 'Groq',        fn: () => this.callGroq(prompt) },
            { name: 'OpenRouter',  fn: () => this.callOpenRouter(prompt) },
            { name: 'HuggingFace', fn: () => this.callHuggingFace(prompt) },
            { name: 'DeepSeek',    fn: () => this.callDeepSeek(prompt) },
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
                    console.warn(`[AiService] analyzeChunkLines parse error (${api.name}):`, parseErr.message);
                    return { modified: false, lines: lines, reason: 'JSON parse failed' };
                }
                if (typeof parsed.modified !== 'boolean') return { modified: false, lines: lines, reason: 'Invalid response shape' };
                return parsed;
            } catch (err) {
                const detail = err.response?.data?.error?.message || err.message;
                errors.push(`${api.name}: ${detail.substring(0, 120)}`);
            }
        }
        throw new Error(`All LLM APIs failed for chunk analysis: ${errors.join(' | ')}`);
    }

    // ── JSON parser with cleanup ──────────────────────────────────────────────
    parseResponse(text) {
        let clean = text.trim();
        // Strip markdown code fences
        clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

        // Extract first valid JSON block
        const jsonStart = clean.indexOf('{') !== -1 ? clean.indexOf('{') : clean.indexOf('[');
        const jsonEndBrace = clean.lastIndexOf('}');
        const jsonEndBracket = clean.lastIndexOf(']');
        const jsonEnd = Math.max(jsonEndBrace, jsonEndBracket);

        if (jsonStart !== -1 && jsonEnd !== -1) {
            clean = clean.substring(jsonStart, jsonEnd + 1);
        }

        // Fix unescaped control characters inside strings
        clean = clean.replace(/[\u0000-\u0019]+/g, (match) =>
            match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
        );

        // Fix trailing commas
        clean = clean.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

        return JSON.parse(clean);
    }

    // ── Groq (multiple models with fallback) ─────────────────────────────────
    async callGroq(prompt) {
        const groqModels = [
            'llama-3.3-70b-versatile',
            'qwen-2.5-coder-32b',
            'llama-3.1-8b-instant',
        ];
        let lastErr;
        for (const model of groqModels) {
            try {
                return await this.withRetry(async () => {
                    const res = await axios.post(
                        'https://api.groq.com/openai/v1/chat/completions',
                        {
                            model,
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
                }, 1, 1000);
            } catch (err) {
                lastErr = err;
                console.warn(`[AiService] Groq ${model} failed:`, err.response?.data?.error?.message || err.message);
            }
        }
        throw lastErr || new Error('Groq failed');
    }

    // ── HuggingFace (multiple models) ────────────────────────────────────────
    async callHuggingFace(prompt) {
        const hfModels = [
            'Qwen/Qwen2.5-72B-Instruct',
            'Qwen/Qwen2.5-Coder-32B-Instruct',
            'mistralai/Mistral-7B-Instruct-v0.3',
            'meta-llama/Meta-Llama-3-8B-Instruct',
        ];
        let lastErr;
        for (const model of hfModels) {
            try {
                return await this.withRetry(async () => {
                    const res = await axios.post(
                        'https://router.huggingface.co/hf-inference/v1/chat/completions',
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

    // ── DeepSeek ─────────────────────────────────────────────────────────────
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

    // ── OpenRouter ────────────────────────────────────────────────────────────
    async callOpenRouter(prompt) {
        const freeModels = [
            'openrouter/free',
            'mistralai/mistral-nemo:free',
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
            }
        }
        throw lastErr || new Error('OpenRouter failed');
    }
}

module.exports = new AiFallbackService();
const { Pinecone } = require('@pinecone-database/pinecone');

class VectorService {
    constructor() {
        this.pipelineOptions = null;
        this.extractor = null;
        this.pinecone = null;
        this.index = null;
    }

    async init() {
        if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) {
            console.warn("[VectorService] Pinecone configuration missing. Vector Memory disabled.");
            return false;
        }

        try {
            this.pinecone = new Pinecone({
                apiKey: process.env.PINECONE_API_KEY,
            });
            this.index = this.pinecone.Index(process.env.PINECONE_INDEX_NAME);

            // Lazy load transformers pipeline for local embeddings (to keep it free)
            const { pipeline } = await import('@xenova/transformers');
            this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
            console.log("[VectorService] Pinecone & Xenova Local Embeddings initialized.");
            return true;
        } catch (e) {
            console.error("[VectorService] Initialization Failed:", e.message);
            return false;
        }
    }

    async generateEmbedding(text) {
        if (!this.extractor) return null;
        const output = await this.extractor(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }

    async embedAndStoreFiles(repoName, files) {
        if (!this.index || !files || files.length === 0) return;

        console.log(`[VectorService] Embedding ${files.length} files for ${repoName}...`);
        const vectors = [];

        for (const file of files) {
            try {
                const content = file.content;
                if (!content || content.length === 0) continue;    // skip blank files
                if (content.length > 50000) continue;              // skip huge files

                const embedding = await this.generateEmbedding(content);
                if (!embedding || embedding.length === 0) continue; // skip failed embeddings

                vectors.push({
                    id: `${repoName}-${file.path}`.replace(/[^a-zA-Z0-9-_]/g, '-'),
                    values: embedding,
                    metadata: {
                        repo: repoName,
                        path: file.path,
                        text: content.substring(0, 1000)
                    }
                });
            } catch (e) {
                console.warn(`[VectorService] Skipping ${file.path}: ${e.message}`);
            }
        }

        if (vectors.length === 0) {
            console.warn(`[VectorService] No vectors generated for ${repoName} — skipping upsert.`);
            return;
        }

        await this.index.upsert(vectors);
        console.log(`[VectorService] Upserted ${vectors.length} vectors to Pinecone.`);
    }

    async searchSimilarContext(query, repoName, topK = 3) {
        if (!this.index) return [];

        try {
            const queryEmbedding = await this.generateEmbedding(query);
            if (!queryEmbedding) return [];

            const queryResponse = await this.index.query({
                vector: queryEmbedding,
                topK,
                includeMetadata: true,
                filter: { repo: repoName }
            });

            return queryResponse.matches.map(m => m.metadata);
        } catch (e) {
            console.error("[VectorService] Search Failed:", e.message);
            return [];
        }
    }
}

module.exports = new VectorService();

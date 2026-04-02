const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
    repository: { type: String, required: true },
    messages: [
        {
            role: { type: String, enum: ['user', 'assistant'], required: true },
            content: { type: String, required: true },
            timestamp: { type: Date, default: Date.now }
        }
    ],
    resolvedInstructions: { type: String }, // The final instruction set to be sent to the agent
    status: { type: String, enum: ['active', 'resolved'], default: 'active' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Chat', chatSchema);

const Groq = require('groq-sdk');

// Initialize Groq client with API key
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

async function getGroqChat(userInput, stack) {
    try {
        // Add user input to conversation stack
        const conversationStack = [...stack];
        conversationStack.push({
            'role': 'user',
            'content': userInput
        });
        
        // Get response from Groq
        const chatCompletion = await groq.chat.completions.create({
            messages: conversationStack,
            model: "llama-3.3-70b-versatile",
            temperature: 0.7,
            max_tokens: 150,  // Keep responses short for 6-year-old
        });
        
        const response = chatCompletion.choices[0]?.message?.content || "I'm sorry, I didn't understand that. Can you say it again?";
        
        // Add response to conversation stack
        stack.push({
            'role': 'user',
            'content': userInput
        });
        stack.push({
            'role': 'assistant',
            'content': response
        });
        
        // Keep stack size manageable (last 20 exchanges)
        if (stack.length > 20) {
            stack.splice(1, 2); // Remove oldest exchange, keep system prompt
        }
        
        return response;
    } catch (error) {
        console.error('Groq API error:', error);
        return "I'm having trouble understanding right now. Can you please say that again?";
    }
}

module.exports = { getGroqChat };

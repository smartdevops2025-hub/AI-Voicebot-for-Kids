const express = require("express");
const http = require("http");
const {getGroqChat} = require('./models/groq');
const WebSocket = require("ws");
const fs = require('fs');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

// ABBU System Prompt - Your Rules for a 6-year-old
let stack = [{
  'role': 'system',
  'content': `You are ABBU, a kind and loving father figure speaking to a 6-year-old child.

  Rules:
  - Speak ONLY in English, using simple words
  - Correct grammar mistakes politely and gently
  - Encourage kindness, honesty, and good manners
  - Ask about school, studies, and reading
  - If child is emotional, empathize first
  - Explain mistakes gently, never use rude language
  - Teach something new in each conversation
  - Keep all answers suitable for age 5-10
  - End each response with a question to continue conversation
  - Keep responses short (2-3 sentences max for a 6-year-old)`
 }];

let keepAlive;
let count=0;
let sid1=0;
let sid2=0;
let pl1=0;
let pl2=0;

// Check for required API keys
if(!process.env.DEEPGRAM_API_KEY && !process.env.GROQ_API_KEY){
    console.error('Please provide DEEPGRAM_API_KEY and GROQ_API_KEY in Secrets');
    process.exit(1);
}

if(!process.env.CARTESIA_API_KEY){
    console.error('Please provide CARTESIA_API_KEY in Secrets');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

function log(message) {
  let text = new Date().toISOString() + " : " + message;
  fs.appendFile('./logs.txt', '\n'+text+'\n', (result)=> { console.log(result)});
}

// ========== CARTESIA TTS WITH YOUR CLONED VOICE ==========
// Your cloned voice ID from Cartesia
const YOUR_CLONED_VOICE_ID = "98a6ed8e-0375-42b8-8a83-a52863f9e70d";
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;

async function speakWithCartesia(responseText, ws) {
    console.time('cartesia_tts');
    log(`Cartesia TTS: Generating speech for: ${responseText.substring(0, 100)}...`);
    
    pl2++;
    sid2++;
    ws.send(JSON.stringify({'type': 'audio_session', 'sid1': sid1, 'sid2': sid2}));
    
    try {
        // Call Cartesia TTS API with your cloned voice
        const response = await axios({
            method: 'post',
            url: 'https://api.cartesia.ai/tts/bytes',
            headers: {
                'X-API-Key': CARTESIA_API_KEY,
                'Content-Type': 'application/json',
                'Cartesia-Version': '2024-06-10'
            },
            data: {
                model_id: 'sonic-english',
                voice: {
                    mode: 'id',
                    id: YOUR_CLONED_VOICE_ID  // YOUR voice!
                },
                output_format: {
                    container: 'raw',
                    encoding: 'pcm_f32le',
                    sample_rate: 24000
                },
                text: responseText,
                language: 'en'
            },
            responseType: 'stream'
        });
        
        // Stream audio chunks to the client in real-time
        response.data.on('data', (chunk) => {
            ws.send(JSON.stringify({
                'type': 'audio',
                'output': Array.from(new Uint8Array(chunk)),
                'sid1': sid1,
                'sid2': sid2
            }));
        });
        
        response.data.on('end', () => {
            console.timeEnd('cartesia_tts');
            log(`Cartesia TTS: Audio generation complete`);
        });
        
        response.data.on('error', (error) => {
            console.error('Cartesia stream error:', error);
            log(`Cartesia stream error: ${error.message}`);
        });
        
    } catch (error) {
        console.error('Cartesia TTS error:', error.response?.data || error.message);
        log(`Cartesia TTS error: ${error.response?.data?.message || error.message}`);
        
        // Fallback: Send a text message if audio fails
        ws.send(JSON.stringify({
            'type': 'caption',
            'output': JSON.stringify("[ABBU said: " + responseText + "]")
        }));
    }
}

// ========== DEEPGRAM SETUP FOR SPEECH RECOGNITION ==========
const setupDeepgram = (ws) => {
  const deepgram = deepgramClient.listen.live({
    language: "en",
    punctuate: true,
    smart_format: true,
    model: "nova-2-phonecall",
    endpointing: 400
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive();
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram: connected");
    log('deepgram: connected');
    
    deepgram.addListener(LiveTranscriptionEvents.Transcript, async (data) => {
      if (data.is_final && data.channel.alternatives[0].transcript !== "") {
        
        if(count > 0){
          if(sid1 !== sid2){
            console.log('stopping the audio');
            ws.send(JSON.stringify({'type': 'audio_stop', 'stop': true}));
          }
        }
        count++;
        sid1 = count;
        pl1++;
        ws.send(JSON.stringify({'type': 'audio_session', 'sid1': sid1 }));

        const words = data.channel.alternatives[0].words;
        const caption = words
            .map((word) => word.punctuated_word ?? word.word)
            .join(" ");
        console.log("Child said:", caption);
        log(`deepgram_spoken: ${caption}`);
        ws.send(JSON.stringify({'type': 'caption', 'output': JSON.stringify(caption)}));
        
        const regex = /disconnect/i;
        if (regex.test(caption)) {
          ws.send(JSON.stringify({'type': 'caption', 'output': JSON.stringify('#assistant stopped#')}));
          deepgram.finish();
          ws.close();
        }
        else {
          console.log("Getting Groq response...");
          const responseText = await getGroqChat(caption, stack);
          console.log("ABBU responds:", responseText);
          log(`groq response: ${responseText}`);
          
          // Use Cartesia TTS with YOUR voice
          await speakWithCartesia(responseText, ws);
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram: disconnected");
      log('deepgram: disconnected');
      clearInterval(keepAlive);
      deepgram.finish();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram: error received");
      console.error(error);
      log(`deepgram error: ${error}`);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram: warning received");
      console.warn(warning);
      log(`deepgram warning: ${warning}`);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram: metadata received");
      ws.send(JSON.stringify({ metadata: data }));
    });
  });

  return deepgram;
};

// ========== WEBSOCKET CONNECTION HANDLER ==========
wss.on("connection", (ws) => {
  console.log("socket: client connected");
  log('socket: client connected');
  let deepgram = setupDeepgram(ws);

  ws.on("message", (message) => {
    if (deepgram.getReadyState() === 1) {
      deepgram.send(message);
    } else if (deepgram.getReadyState() >= 2) {
      console.log("socket: data couldn't be sent to deepgram");
      log('reattempting to send data');
      deepgram.finish();
      deepgram.removeAllListeners();
      deepgram = setupDeepgram(ws);
    } else {
      console.log("socket: data couldn't be sent to deepgram");
    }
  });

  ws.on("close", () => {
    console.log("socket: client disconnected");
    log('socket: client disconnected');
    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
  });
});

// ========== STATIC FILES AND ROUTES ==========
app.use(express.static("public/"));
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 7860;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`ABBU is running on port ${PORT}`);
  console.log(`Using Cartesia with cloned voice ID: ${YOUR_CLONED_VOICE_ID}`);
  console.log(`Your son can now talk to ABBU! 🎉`);
  console.log(`========================================`);
});

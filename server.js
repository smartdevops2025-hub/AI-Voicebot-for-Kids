const express = require("express");
const http = require("http");
const {getGroqChat} = require('./models/groq');
const WebSocket = require("ws");
const fs = require('fs');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const dotenv = require("dotenv");
// REPLACED: const {play , initialize} = require('./models/playht');
// NEW: Edge TTS (free, no API key!)
const { Communicate } = require('edge-tts-universal');

dotenv.config();

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
  - End each response with a question to continue conversation`
 }];

let keepAlive;
let count=0;
let sid1=0;
let sid2=0;
let pl1=0;
let pl2=0;

// Only check for Deepgram and Groq keys (Edge TTS needs no key!)
if(!process.env.DEEPGRAM_API_KEY && !process.env.GROQ_API_KEY){
    console.error('Please provide DEEPGRAM_API_KEY and GROQ_API_KEY in Secrets')
    process.exit(1);
}

const app = express();
const server = http.createServer(app)
const wss = new WebSocket.Server({ server });
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

function log(message) {
  let text = new Date().toISOString() + " : " + message;
  fs.appendFile('./logs.txt', '\n'+text+'\n', (result)=> { console.log(result)});
}

// NEW: Edge TTS function (replaces PlayHT)
async function speakWithEdgeTTS(responseText, ws) {
  console.time('edge_tts_api');
  pl2++;
  sid2++;
  ws.send(JSON.stringify({'type': 'audio_session', 'sid1': sid1, 'sid2': sid2}));
  
  try {
    // Use a clear, child-friendly English voice
    const communicate = new Communicate(responseText, {
      voice: 'en-US-EmmaMultilingualNeural',  // Clear female US voice, great for kids
    });
    
    const audioChunks = [];
    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        audioChunks.push(chunk.data);
        
        // Send audio chunk to client in real-time
        const buffer = Buffer.from(chunk.data);
        ws.send(JSON.stringify({
          'type': 'audio',
          'output': Array.from(new Uint8Array(buffer)),
          'sid1': sid1,
          'sid2': sid2
        }));
      }
    }
    console.timeEnd('edge_tts_api');
    log(`Edge TTS: Generated ${audioChunks.length} audio chunks`);
  } catch (error) {
    console.error('Edge TTS error:', error);
    log(`Edge TTS error: ${error.message}`);
  }
}

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
    
    deepgram.addListener(LiveTranscriptionEvents.Transcript, async (data) => {
      if (data.is_final && data.channel.alternatives[0].transcript !== "") {
        
        if(count>0){
          if(sid1 !== sid2){
            console.log('stopping the audio')
            ws.send(JSON.stringify({'type': 'audio_stop', 'stop': true}));
          }
        }
        count++
        sid1 = count
        pl1++
        ws.send(JSON.stringify({'type': 'audio_session', 'sid1': sid1 }));

        const words = data.channel.alternatives[0].words;
        const caption = words
            .map((word) => word.punctuated_word ?? word.word)
            .join(" ");
        console.log(caption)
        log(`deepgram_spoken: ${caption}`)
        ws.send(JSON.stringify({'type': 'caption', 'output': JSON.stringify(caption)}));
        
        const regex = /disconnect/i;
        if (regex.test(caption)) {
          ws.send(JSON.stringify({'type': 'caption', 'output': JSON.stringify('#assistant stopped#')}));
          deepgram.finish();
          ws.close();
        }
        else {
          const responseText = await getGroqChat(caption, stack);
          log(`groq response: ${responseText}`)
          // REPLACED: await playh(responseText)
          await speakWithEdgeTTS(responseText, ws);
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram: disconnected");
      log('deepgram: disconnected')
      clearInterval(keepAlive);
      deepgram.finish();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram: packet received");
      console.log("deepgram: metadata received");
      console.log("ws: metadata sent to client");
      ws.send(JSON.stringify({ metadata: data }));
    });
  });

  return deepgram;
};

wss.on("connection", (ws) => {
  console.log("socket: client connected");
  log('socket: client connected')
  let deepgram = setupDeepgram(ws);

  ws.on("message", (message) => {
    if (deepgram.getReadyState() === 1) {
      deepgram.send(message);
    } else if (deepgram.getReadyState() >= 2) {
      console.log("socket: data couldn't be sent to deepgram");
      log('reattempting to send data')
      deepgram.finish();
      deepgram.removeAllListeners();
      deepgram = setupDeepgram(ws);
    } else {
      console.log("socket: data couldn't be sent to deepgram");
    }
  });

  ws.on("close", () => {
    console.log("socket: client disconnected");
    log('socket: client disconnected')
    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
  });
});

app.use(express.static("public/"));
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

const PORT = process.env.PORT || 7860;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ABBU is running on port ${PORT}`);
});

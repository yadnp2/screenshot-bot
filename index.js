require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const puppeteer = require('puppeteer');
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function parseCommand(text) {
  text = text.trim();

  // Direct URL
  if (text.toLowerCase().startsWith('ss http')) {
    return text.slice(3).trim();
  }

  // X/Twitter profile
  if (text.toLowerCase().startsWith('x @')) {
    const username = text.slice(3).trim();
    return `https://x.com/${username}`;
  }

  // X/Twitter URL
  if (text.toLowerCase().startsWith('x http')) {
    return text.slice(2).trim();
  }

  // Reddit
  if (text.toLowerCase().startsWith('reddit ')) {
    const sub = text.slice(7).trim();
    return `https://reddit.com/r/${sub}`;
  }

  // Wikipedia
  if (text.toLowerCase().startsWith('wiki ')) {
    const topic = text.slice(5).trim().replace(/ /g, '_');
    return `https://en.wikipedia.org/wiki/${topic}`;
  }

  // YouTube search
  if (text.toLowerCase().startsWith('yt ')) {
    const query = text.slice(3).trim().replace(/ /g, '+');
    return `https://www.youtube.com/results?search_query=${query}`;
  }

  // Google fallback — get first result
  const searchQuery = encodeURIComponent(text);
  const searchUrl = `https://www.google.com/search?q=${searchQuery}`;

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/render/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  // Grab first organic result
  const firstUrl = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a[jsname]');
    for (const a of anchors) {
      const href = a.href;
      if (href && href.startsWith('http') && !href.includes('google.com')) {
        return href;
      }
    }
    return null;
  });

  await browser.close();
  return firstUrl || searchUrl;
}

async function takeScreenshot(url) {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/render/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
  await browser.close();
  return buffer;
}

async function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'screenshots', resource_type: 'image' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// Test web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Screenshot Bot Tester</title>
      <style>
        body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
        input { width: 100%; padding: 12px; font-size: 16px; margin: 10px 0; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; }
        button { padding: 12px 24px; font-size: 16px; background: #0066ff; color: white; border: none; border-radius: 6px; cursor: pointer; }
        #result { margin-top: 20px; }
        #result img { max-width: 100%; border-radius: 8px; margin-top: 10px; }
        #status { color: #666; font-style: italic; margin-top: 10px; }
        .commands { background: #f5f5f5; padding: 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; line-height: 1.8; }
      </style>
    </head>
    <body>
      <h2>📸 Screenshot Bot Tester</h2>
      <div class="commands">
        <strong>Commands:</strong><br>
        <code>ss https://example.com</code> — exact URL<br>
        <code>x @username</code> — X/Twitter profile<br>
        <code>reddit worldnews</code> — subreddit<br>
        <code>wiki Albert Einstein</code> — Wikipedia<br>
        <code>yt lofi music</code> — YouTube search<br>
        <code>fox news</code> — anything else = Google it
      </div>
      <input type="text" id="cmd" placeholder="Try: fox news" />
      <button onclick="run()">Get Screenshot</button>
      <div id="status"></div>
      <div id="result"></div>
      <script>
        async function run() {
          const cmd = document.getElementById('cmd').value.trim();
          if (!cmd) return;
          document.getElementById('status').innerText = 'Taking screenshot...';
          document.getElementById('result').innerHTML = '';
          const res = await fetch('/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
          });
          const data = await res.json();
          document.getElementById('status').innerText = '';
          if (data.imageUrl) {
            document.getElementById('result').innerHTML = '<p>✅ Done! URL: <a href="' + data.url + '" target="_blank">' + data.url + '</a></p><img src="' + data.imageUrl + '" />';
          } else {
            document.getElementById('result').innerHTML = '<p>❌ Error: ' + data.error + '</p>';
          }
        }
        document.getElementById('cmd').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
      </script>
    </body>
    </html>
  `);
});

// Test endpoint
app.post('/test', async (req, res) => {
  const { command } = req.body;
  try {
    const url = await parseCommand(command);
    const buffer = await takeScreenshot(url);
    const imageUrl = await uploadToCloudinary(buffer);
    res.json({ imageUrl, url });
  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
  }
});

// Twilio webhook
app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const from = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    twiml.message('Got it! Taking screenshot, give me a few seconds...');
    res.type('text/xml').send(twiml.toString());

    const url = await parseCommand(incomingMsg);
    const buffer = await takeScreenshot(url);
    const imageUrl = await uploadToCloudinary(buffer);

    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from,
      mediaUrl: [imageUrl],
    });
  } catch (err) {
    console.error(err);
    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from,
      body: 'Sorry, something went wrong. Try again!',
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

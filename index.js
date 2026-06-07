require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const cloudinary = require('cloudinary').v2;
const fetch = require('node-fetch');
const { Resend } = require('resend');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendMMS(imageUrl, caption) {
  const imageBuffer = await fetch(imageUrl).then(r => r.buffer());
  const base64Image = imageBuffer.toString('base64');

  const sendEmail = async () => {
    return await resend.emails.send({
      from: 'Screenshot Bot <onboarding@resend.dev>',
      to: process.env.GMAIL_USER,
      subject: 'Screenshot',
      text: caption || '',
      attachments: [
        {
          filename: 'screenshot.jpg',
          content: base64Image,
        },
      ],
    });
  };

  try {
    const result = await sendEmail();
    if (result.error) throw new Error(JSON.stringify(result.error));
    console.log('MMS sent successfully');
  } catch (err) {
    console.log('First attempt failed, retrying...', err.message);
    await new Promise(r => setTimeout(r, 3000));
    const result = await sendEmail();
    if (result.error) throw new Error(JSON.stringify(result.error));
  }
}

async function parseUrl(text) {
  text = text.trim();

  // Auto-detect www. URLs
  if (text.toLowerCase().startsWith('www.')) {
    return `https://${text}`;
  }

  if (text.toLowerCase().startsWith('ss http')) {
    return text.slice(3).trim();
  }

  // Also handle ss www.
  if (text.toLowerCase().startsWith('ss www.')) {
    return `https://${text.slice(3).trim()}`;
  }

  if (text.toLowerCase().startsWith('x @')) {
    const username = text.slice(3).trim().split(' ')[0];
    return `https://x.com/${username}`;
  }
  if (text.toLowerCase().startsWith('x http')) {
    return text.slice(2).trim();
  }
  if (text.toLowerCase().startsWith('reddit ')) {
    return `https://reddit.com/r/${text.slice(7).trim()}`;
  }
  if (text.toLowerCase().startsWith('wiki ')) {
    return `https://en.wikipedia.org/wiki/${text.slice(5).trim().replace(/ /g, '_')}`;
  }
  if (text.toLowerCase().startsWith('yt ')) {
    return `https://www.youtube.com/results?search_query=${text.slice(3).trim().replace(/ /g, '+')}`;
  }
  if (text.toLowerCase().startsWith('img ')) {
    return `https://www.bing.com/images/search?q=${encodeURIComponent(text.slice(4).trim())}&safeSearch=Off`;
  }

  const directSites = {
    'fox news': 'https://www.foxnews.com',
    'cnn': 'https://www.cnn.com',
    'bbc': 'https://www.bbc.com',
    'nbc': 'https://www.nbcnews.com',
    'abc news': 'https://abcnews.go.com',
    'nyt': 'https://www.nytimes.com',
    'new york times': 'https://www.nytimes.com',
    'washington post': 'https://www.washingtonpost.com',
    'espn': 'https://www.espn.com',
    'weather': 'https://weather.com',
    'amazon': 'https://www.amazon.com',
    'ebay': 'https://www.ebay.com',
    'netflix': 'https://www.netflix.com',
    'instagram': 'https://www.instagram.com',
    'facebook': 'https://www.facebook.com',
    'tiktok': 'https://www.tiktok.com',
  };

  const lowerText = text.toLowerCase();
  if (directSites[lowerText]) {
    return directSites[lowerText];
  }

  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

async function takeScreenshotBrowserless(url) {
  console.log('Trying Browserless for:', url);
  const token = process.env.BROWSERLESS_API_KEY?.trim();
  if (!token) throw new Error('Missing BROWSERLESS_API_KEY');
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}`,
  });
  try {
   name page.setCookie({
    name 'SRCHHPGUSR',
    value: 'ADLT=OFF',
    domain '.bing.com',
    url: 'https://www.bing.com',
  });
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Scroll down for X profiles to show posts
    if (url.includes('x.com') || url.includes('twitter.com')) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 1000));
    }

    return await page.screenshot({ type: 'jpeg', quality: 80 });
  } finally {
    await browser.close();
  }
}

async function takeScreenshotOne(url) {
  console.log('Trying ScreenshotOne for:', url);
  const params = new URLSearchParams({
    access_key: process.env.SCREENSHOTONE_KEY,
    url: url,
    viewport_width: '1280',
    viewport_height: '800',
    format: 'jpg',
    image_quality: '80',
    block_ads: 'true',
    block_cookie_banners: 'true',
    block_trackers: 'true',
    ignore_host_errors: 'true',
    delay: '2000',
  });

  // Scroll down for X profiles
  if (url.includes('x.com') || url.includes('twitter.com')) {
    params.append('scroll_y', '500');
  }

  const screenshotUrl = `https://api.screenshotone.com/take?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const response = await fetch(screenshotUrl, { signal: controller.signal });
  clearTimeout(timeout);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ScreenshotOne error: ${errorText}`);
  }

  return await response.buffer();
}

async function takeScreenshot(url) {
  console.log('Taking screenshot of:', url);
  try {
    return await takeScreenshotBrowserless(url);
  } catch (err) {
    console.log('Browserless failed, falling back to ScreenshotOne:', err.message);
    return await takeScreenshotOne(url);
  }
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

async function processCommand(command) {
  const url = await parseUrl(command);
  const buffer = await takeScreenshot(url);
  const imageUrl = await uploadToCloudinary(buffer);
  return { url, imageUrl };
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Screenshot Bot Tester</title>
      <style>
        body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
        input { width: 100%; padding: 12px; font-size: 16px; margin: 10px 0; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; }
        button { padding: 12px 24px; font-size: 16px; background: #0066ff; color: white; border: none; border-radius: 6px; cursor: pointer; margin-right: 10px; }
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
        <code>www.example.com</code> — any website directly<br>
        <code>ss https://example.com</code> — exact URL<br>
        <code>x @username</code> — X/Twitter posts<br>
        <code>reddit worldnews</code> — subreddit<br>
        <code>wiki Albert Einstein</code> — Wikipedia<br>
        <code>yt lofi music</code> — YouTube search<br>
        <code>img tuna</code> — Bing image search<br>
        <code>fox news</code> — anything else = smart search
      </div>
      <input type="text" id="cmd" placeholder="Try: www.foxnews.com" />
      <button onclick="run()">Test in Browser</button>
      <button onclick="runMMS()">Send to My Phone</button>
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
        async function runMMS() {
          const cmd = document.getElementById('cmd').value.trim();
          if (!cmd) return;
          document.getElementById('status').innerText = 'Taking screenshot and sending to your phone...';
          document.getElementById('result').innerHTML = '';
          const res = await fetch('/test-mms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
          });
          const data = await res.json();
          document.getElementById('status').innerText = '';
          if (data.success) {
            document.getElementById('result').innerHTML = '<p>✅ Sent to your phone! URL: <a href="' + data.url + '" target="_blank">' + data.url + '</a></p><img src="' + data.imageUrl + '" />';
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

app.post('/test', async (req, res) => {
  const { command } = req.body;
  try {
    const { url, imageUrl } = await processCommand(command);
    res.json({ imageUrl, url });
  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
  }
});

app.post('/test-mms', async (req, res) => {
  const { command } = req.body;
  try {
    const { url, imageUrl } = await processCommand(command);
    await sendMMS(imageUrl, url);
    res.json({ success: true, imageUrl, url });
  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
  }
});

app.post('/sms', async (req, res) => {
  console.log('Full request body:', JSON.stringify(req.body));
  const raw = (req.body.command || req.body.Command || '').trim();
  const messageMatch = raw.match(/Message:\s*(.+?)(\r?\n|$)/i);
  const command = messageMatch ? messageMatch[1].trim() : raw;
  console.log('Parsed command:', command);

  if (!command) {
    return res.json({ success: false, error: 'No command received' });
  }

  res.json({ success: true, message: 'Processing...' });

  try {
    const { url, imageUrl } = await processCommand(command);
    await sendMMS(imageUrl, url);
    console.log('Screenshot sent for:', command);
  } catch (err) {
    console.error('Error processing command:', err.message);
  }
});

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const from = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    twiml.message('Got it! Taking screenshot, give me a few seconds...');
    res.type('text/xml').send(twiml.toString());

    const { imageUrl } = await processCommand(incomingMsg);

    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from,
      mediaUrl: [imageUrl],
    });
  } catch (err) {
    console.error(err);
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from,
      body: 'Sorry, something went wrong. Try again!',
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

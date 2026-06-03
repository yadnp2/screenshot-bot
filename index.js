require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const { ImapFlow } = require('imapflow');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendMMS(imageUrl, caption) {
  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: `${process.env.VERIZON_NUMBER}@mypixmessages.com`,
    subject: '',
    text: caption || '',
    attachments: [
      {
        filename: 'screenshot.jpg',
        path: imageUrl,
      },
    ],
  };
  try {
    await transporter.sendMail(mailOptions);
    console.log('MMS sent successfully');
  } catch (err) {
    console.log('First attempt failed, retrying...', err.message);
    await new Promise(r => setTimeout(r, 3000));
    await transporter.sendMail(mailOptions);
  }
}

function parseUrl(text) {
  text = text.trim();

  if (text.toLowerCase().startsWith('ss http')) {
    return text.slice(3).trim();
  }
  if (text.toLowerCase().startsWith('x @')) {
    return `https://x.com/${text.slice(3).trim()}`;
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

  // DuckDuckGo "I'm Feeling Lucky" style — just build search URL
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

async function takeScreenshot(url) {
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
  });

  const screenshotUrl = `https://api.screenshotone.com/take?${params.toString()}`;
  const response = await fetch(screenshotUrl);

  if (!response.ok) {
    throw new Error(`Screenshot API error: ${response.statusText}`);
  }

  const buffer = await response.buffer();
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

async function processCommand(command) {
  const url = parseUrl(command);
  const buffer = await takeScreenshot(url);
  const imageUrl = await uploadToCloudinary(buffer);
  return { url, imageUrl };
}

// Gmail IMAP polling
async function startGmailPolling() {
  console.log('Starting Gmail IMAP polling...');

  const checkMail = async () => {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Search for unread emails from vtext
        const messages = await client.search({
          unseen: true,
          from: `${process.env.VERIZON_NUMBER}@vtext.com`,
        });

        for (const uid of messages) {
          const message = await client.fetchOne(uid, { source: true, envelope: true });
          const subject = message.envelope.subject || '';
          const command = subject.trim();

          console.log('Received SMS command:', command);

          // Mark as read
          await client.messageFlagsAdd(uid, ['\\Seen']);

          if (command) {
            try {
              const { url, imageUrl } = await processCommand(command);
              await sendMMS(imageUrl, url);
              console.log('Screenshot sent for:', command);
            } catch (err) {
              console.error('Error processing command:', err.message);
              await sendMMS(null, `Sorry, could not get screenshot for: ${command}`);
            }
          }
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      console.error('IMAP error:', err.message);
    }
  };

  // Check every 15 seconds
  setInterval(checkMail, 15000);
  checkMail(); // run immediately on startup
}

// Web test interface
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
        <code>ss https://example.com</code> — exact URL<br>
        <code>x @username</code> — X/Twitter profile<br>
        <code>reddit worldnews</code> — subreddit<br>
        <code>wiki Albert Einstein</code> — Wikipedia<br>
        <code>yt lofi music</code> — YouTube search<br>
        <code>fox news</code> — anything else = DuckDuckGo it
      </div>
      <input type="text" id="cmd" placeholder="Try: fox news" />
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
  startGmailPolling();
});

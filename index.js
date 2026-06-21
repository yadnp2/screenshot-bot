require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const cloudinary = require('cloudinary').v2;
const fetch = require('node-fetch');
const { Resend } = require('resend');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

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

console.log('BROWSERLESS_API_KEY present:', !!process.env.BROWSERLESS_API_KEY);

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

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }
  return url;
}

function looksLikeUrl(text) {
  const t = text.trim().toLowerCase();
  return t.startsWith('http') || /^[\w-]+\.[a-z]{2,}/.test(t.split(' ')[0]);
}

const DIRECT_SITES = {
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

async function resolveToHomepage(text) {
  const lowerText = text.toLowerCase().trim();
  if (DIRECT_SITES[lowerText]) {
    return DIRECT_SITES[lowerText];
  }
  if (looksLikeUrl(text)) {
    return normalizeUrl(text);
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

async function parseUrl(text) {
  text = text.trim();

  if (text.toLowerCase().startsWith('ss ')) {
    return normalizeUrl(text.slice(3));
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
  if (text.toLowerCase().startsWith('img ')) {
    return `https://www.bing.com/images/search?q=${encodeURIComponent(text.slice(4).trim())}&safeSearch=Off`;
  }

  const lowerText = text.toLowerCase();
  if (DIRECT_SITES[lowerText]) {
    return DIRECT_SITES[lowerText];
  }

  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

async function dismissOverlay(page) {
  try {
    let totalClicked = 0;
    for (let pass = 0; pass < 2; pass++) {
      const clicked = await page.evaluate(() => {
        const texts = [
          'i am 18', 'i am 18+', "i'm 18", "i'm 18+",
          'i am of legal age', 'confirm age', 'verify age',
          'i am an adult', 'enter site', 'click to enter',
          'i am over 18', 'i am over 21', 'legal age',
          'age verification',
          'accept all', 'accept cookies', 'accept', 'i accept',
          'got it', 'i agree', 'agree', 'allow all', 'allow',
          'continue', 'proceed', 'ok', 'okay', 'dismiss',
          'close', 'no thanks', 'not now', 'i understand',
          'consent', 'agree and continue', 'yes', 'verify', 'confirm'
        ];
        const elements = document.querySelectorAll(
          'button, a, div[role="button"], span[role="button"], input[type="button"], input[type="submit"]'
        );
        for (const el of elements) {
          const elText = (el.innerText || el.value || '').toLowerCase().trim();
          if (texts.some(t => elText === t || elText.includes(t))) {
            el.click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        totalClicked++;
        await new Promise(r => setTimeout(r, 1500));
      } else {
        break;
      }
    }

    if (totalClicked > 0) {
      console.log('Dismissed', totalClicked, 'overlay(s)');
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    console.log('Overlay dismissal error:', e.message);
  }
}

async function connectBrowser() {
  const token = process.env.BROWSERLESS_API_KEY?.trim();
  if (!token) throw new Error('Missing BROWSERLESS_API_KEY');
  return await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}`,
  });
}

async function setupPage(browser) {
  const page = await browser.newPage();

  const failedResources = [];
  page.on('requestfailed', request => {
    const failure = request.failure();
    failedResources.push(request.url() + ' - ' + (failure ? failure.errorText : 'unknown'));
  });

  await page.setCookie({
    name: 'SRCHHPGUSR',
    value: 'ADLT=OFF',
    domain: '.bing.com',
    url: 'https://www.bing.com',
  });

  await page.setViewport({ width: 1280, height: 1600 });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  page._failedResources = failedResources;
  return page;
}

async function waitForImages(page) {
  await page.evaluate(async () => {
    const images = Array.from(document.images);
    await Promise.all(images.map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        img.addEventListener('load', resolve);
        img.addEventListener('error', resolve);
        setTimeout(resolve, 5000);
      });
    }));
  });
}

async function takeScreenshotBrowserless(url) {
  console.log('Trying Browserless for:', url);
  const browser = await connectBrowser();
  try {
    const page = await setupPage(browser);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForImages(page);
    await dismissOverlay(page);
    console.log('Failed resources:', JSON.stringify(page._failedResources.slice(0, 20)));
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
    viewport_height: '1600',
    format: 'jpg',
    image_quality: '80',
    block_cookie_banners: 'true',
    ignore_host_errors: 'true',
  });

  const screenshotUrl = `https://api.screenshotone.com/take?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
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

// ---- Group 2 features ----

async function takeReadScreenshotFromHtml(html, baseUrl) {
  const dom = new JSDOM(html, { url: baseUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    throw new Error('Could not extract readable content from this page');
  }

  const safeTitle = (article.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const readableHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Georgia, serif; max-width: 700px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #222; }
        h1 { font-size: 28px; margin-bottom: 8px; }
        .byline { color: #666; font-size: 14px; margin-bottom: 24px; }
        img { max-width: 100%; height: auto; }
        a { color: #0645ad; }
      </style>
    </head>
    <body>
      <h1>${safeTitle}</h1>
      <div class="byline">${article.byline || ''}</div>
      ${article.content}
    </body>
    </html>
  `;

  const browser = await connectBrowser();
  try {
    const page = await setupPage(browser);
    await page.setContent(readableHtml, { waitUntil: 'domcontentloaded' });
    await waitForImages(page);
    return await page.screenshot({ type: 'jpeg', quality: 85, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function takeReadScreenshot(url) {
  console.log('Building read mode for:', url);
  const browser = await connectBrowser();
  let html;
  try {
    const page = await setupPage(browser);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));
    await dismissOverlay(page);
    html = await page.content();
  } finally {
    await browser.close();
  }
  return await takeReadScreenshotFromHtml(html, url);
}

async function findTopArticleUrlOnPage(page, baseUrl) {
  return await page.evaluate((base) => {
    const origin = new URL(base).origin;
    const links = Array.from(document.querySelectorAll('a[href]'));

    const candidates = links
      .map(a => {
        const href = a.getAttribute('href');
        if (!href) return null;
        let abs;
        try {
          abs = new URL(href, base).toString();
        } catch (e) {
          return null;
        }
        const text = (a.innerText || '').trim();
        return { abs, text, rect: a.getBoundingClientRect() };
      })
      .filter(c => c && c.abs.startsWith(origin))
      .filter(c => c.text.length > 25)
      .filter(c => /\/[a-z0-9-]{10,}/i.test(new URL(c.abs).pathname))
      .filter(c => c.rect.top >= 0 && c.rect.top < 1200);

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.rect.top - b.rect.top);
    return candidates[0].abs;
  }, baseUrl);
}

async function takeReadFromTopic(topicOrSite) {
  const homepage = await resolveToHomepage(topicOrSite);
  console.log('Resolved', topicOrSite, '->', homepage);

  const browser = await connectBrowser();
  let articleUrl, articleHtml;
  try {
    const page = await setupPage(browser);
    await page.goto(homepage, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));
    await dismissOverlay(page);

    articleUrl = await findTopArticleUrlOnPage(page, homepage);
    if (!articleUrl) {
      throw new Error('Could not find a top article on ' + homepage);
    }
    console.log('Top article found:', articleUrl);

    // Reuse the same browser/page for the article navigation to avoid a second connection
    await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));
    await dismissOverlay(page);
    articleHtml = await page.content();
  } finally {
    await browser.close();
  }

  const buffer = await takeReadScreenshotFromHtml(articleHtml, articleUrl);
  return { buffer, articleUrl };
}

function langToCode(lang) {
  const map = {
    spanish: 'es', french: 'fr', german: 'de', italian: 'it',
    portuguese: 'pt', hebrew: 'he', yiddish: 'yi', russian: 'ru',
    chinese: 'zh-CN', japanese: 'ja', korean: 'ko', arabic: 'ar',
  };
  return map[lang.toLowerCase().trim()] || lang.trim();
}

async function takeTranslateScreenshot(url, lang) {
  const code = langToCode(lang);
  const translateUrl = `https://translate.google.com/translate?sl=auto&tl=${code}&u=${encodeURIComponent(url)}`;
  return await takeScreenshot(translateUrl);
}

async function takeCompareScreenshot(urls) {
  console.log('Comparing', urls.length, 'sites:', urls.join(' | '));

  const buffers = await Promise.all(urls.map(u => takeScreenshot(u)));

  const targetWidth = urls.length <= 2 ? 640 : urls.length === 3 ? 460 : 360;
  const gap = 8;

  const metas = await Promise.all(buffers.map(b => sharp(b).metadata()));
  const heights = metas.map((m) => Math.round((m.height / m.width) * targetWidth));
  const maxHeight = Math.max(...heights);

  const resized = await Promise.all(
    buffers.map(b =>
      sharp(b).resize(targetWidth, maxHeight, { fit: 'cover', position: 'top' }).toBuffer()
    )
  );

  const perRow = urls.length <= 3 ? urls.length : 3;
  const rows = Math.ceil(urls.length / perRow);
  const totalWidth = perRow * targetWidth + (perRow - 1) * gap;
  const totalHeight = rows * maxHeight + (rows - 1) * gap;

  const composite = resized.map((buf, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    return {
      input: buf,
      left: col * (targetWidth + gap),
      top: row * (maxHeight + gap),
    };
  });

  const combined = await sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composite)
    .jpeg({ quality: 85 })
    .toBuffer();

  return combined;
}

// ---- end Group 2 features ----

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
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith('read ')) {
    const target = trimmed.slice(5).trim();

    if (looksLikeUrl(target)) {
      const url = normalizeUrl(target);
      const buffer = await takeReadScreenshot(url);
      const imageUrl = await uploadToCloudinary(buffer);
      return { url, imageUrl };
    } else {
      const { buffer, articleUrl } = await takeReadFromTopic(target);
      const imageUrl = await uploadToCloudinary(buffer);
      return { url: articleUrl, imageUrl };
    }
  }

  const translateMatch = trimmed.match(/^translate\s+(\S+)\s+to\s+(.+)$/i);
  if (translateMatch) {
    const url = normalizeUrl(translateMatch[1]);
    const lang = translateMatch[2];
    const buffer = await takeTranslateScreenshot(url, lang);
    const imageUrl = await uploadToCloudinary(buffer);
    return { url: `translate(${lang}): ${url}`, imageUrl };
  }

  if (lower.startsWith('compare ')) {
    const rest = trimmed.slice(8);
    const parts = rest.split(/\s+vs\s+/i).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const urls = parts.map(normalizeUrl);
      const buffer = await takeCompareScreenshot(urls);
      const imageUrl = await uploadToCloudinary(buffer);
      return { url: urls.join(' vs '), imageUrl };
    }
  }

  const url = await parseUrl(trimmed);
  const buffer = await takeScreenshot(url);
  const imageUrl = await uploadToCloudinary(buffer);
  return { url, imageUrl };
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Photo Tools - Image Utility</title>
      <meta name="description" content="Simple online photo and image utility tool for everyday use.">
      <meta name="keywords" content="photo, image, tools, utility, pictures">
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
      <div class="commands">
        <strong>Commands:</strong><br>
        <code>ss https://example.com</code> — exact URL<br>
        <code>x @username</code> — X/Twitter profile<br>
        <code>reddit worldnews</code> — subreddit<br>
        <code>wiki Albert Einstein</code> — Wikipedia<br>
        <code>yt lofi music</code> — YouTube search<br>
        <code>img tuna</code> — Bing image search<br>
        <code>read https://site.com/article</code> — clean readable article (exact URL)<br>
        <code>read fox news</code> — finds and reads the top story automatically<br>
        <code>translate https://site.com to spanish</code> — translated page<br>
        <code>compare site1.com vs site2.com vs site3.com</code> — side-by-side, any number of sites<br>
        <code>fox news</code> — anything else = smart search
      </div>
      <input type="text" id="cmd" placeholder="Try: read fox news" />
      <button onclick="run()">Test in Browser</button>
      <button onclick="runMMS()">Send to My Phone</button>
      <div id="status"></div>
      <div id="result"></div>
      <script>
        async function run() {
          const cmd = document.getElementById('cmd').value.trim();
          if (!cmd) return;
          document.getElementById('status').innerText = 'Working on it...';
          document.getElementById('result').innerHTML = '';
          const res = await fetch('/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
          });
          const data = await res.json();
          document.getElementById('status').innerText = '';
          if (data.imageUrl) {
            document.getElementById('result').innerHTML = '<p>✅ Done! ' + data.url + '</p><img src="' + data.imageUrl + '" />';
          } else {
            document.getElementById('result').innerHTML = '<p>❌ Error: ' + data.error + '</p>';
          }
        }
        async function runMMS() {
          const cmd = document.getElementById('cmd').value.trim();
          if (!cmd) return;
          document.getElementById('status').innerText = 'Working on it and sending to your phone...';
          document.getElementById('result').innerHTML = '';
          const res = await fetch('/test-mms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
          });
          const data = await res.json();
          document.getElementById('status').innerText = '';
          if (data.success) {
            document.getElementById('result').innerHTML = '<p>✅ Sent to your phone! ' + data.url + '</p><img src="' + data.imageUrl + '" />';
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
    twiml.message('Got it! Working on your request...');
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

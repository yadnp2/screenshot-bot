require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const puppeteer = require('puppeteer');
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(express.urlencoded({ extended: false }));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function takeScreenshot(url) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
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

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const from = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  let url = null;

  if (incomingMsg.toLowerCase().startsWith('ss ')) {
    url = incomingMsg.slice(3).trim();
  } else if (incomingMsg.toLowerCase().startsWith('x ')) {
    url = incomingMsg.slice(2).trim();
  }

  if (!url) {
    twiml.message('Commands:\nss <url> — screenshot any site\nx <url> — screenshot an X/Twitter thread');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  try {
    twiml.message('Got it! Taking screenshot, give me a few seconds...');
    res.type('text/xml').send(twiml.toString());

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
      body: 'Sorry, something went wrong. Make sure the URL is valid and starts with https://',
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
